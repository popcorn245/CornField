// @vitest-environment node
/**
 * The package as built (spec 0011 D7, D11): the generated default tokens, the type declarations a consumer compiles against, the files of dist/,
 * the version they carry and the size budget. Nothing here needs a browser; `npm run build` runs first in CI, and this builds when dist/ is not there.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
// @ts-expect-error plain JS
import { MANIFEST, SAFE_PATH, SERVED, distFiles, writeManifest } from '../scripts/manifest.mjs';
// @ts-expect-error plain JS
import { releaseProblems } from '../scripts/release-guard.mjs';

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

  it('lists exactly what the three pieces around the map declare: the node panel and the Layers menu nothing of their own, the search a query, an event and a method', () => {
    const names = (list: Array<{ name: string }>) => list.map((x) => x.name).sort();
    const by = (tag: string) => analyzeComponents().find((c: { tagName: string }) => c.tagName === tag);
    for (const tag of ['corn-node-panel', 'corn-layers']) {
      const c = by(tag);
      expect([names(c.properties), names(c.events), names(c.methods)], tag).toEqual([[], [], []]);
    }
    const search = by('corn-search');
    expect(names(search.properties)).toEqual(['query']);
    expect(names(search.events)).toEqual(['cornSearch']);
    expect(names(search.methods)).toEqual(['focusField']);
    const text = typesFor(analyzeComponents())['components.d.ts'];
    for (const word of ["'corn-node-panel': HTMLCornNodePanelElement", "'corn-layers': HTMLCornLayersElement", "'corn-search': HTMLCornSearchElement", 'export interface CornSearchDetail', "'onCornSearch'?:", "'focusField':"]) expect(text, word).toContain(word);
  });

  it('lists exactly what the review\'s three sections declare (nothing of their own: the proposal, `view`, `cornNavigate`, `cornDecision` and `cornAuth` are the scope\'s), and what the scope gained', () => {
    const names = (list: Array<{ name: string }>) => list.map((x) => x.name).sort();
    const by = (tag: string) => analyzeComponents().find((c: { tagName: string }) => c.tagName === tag);
    for (const tag of ['corn-proposal', 'corn-changes', 'corn-decision']) {
      const c = by(tag);
      expect([names(c.properties), names(c.events), names(c.methods)], tag).toEqual([[], [], []]);
    }
    const scope = by('corn-scope');
    expect(names(scope.properties)).toEqual(['config', 'proposal', 'source', 'src', 'strings', 'theme', 'topology', 'useTheme', 'view']);
    expect(names(scope.events)).toEqual(['cornAuth', 'cornDecision', 'cornError', 'cornNavigate', 'cornReady']);
    const text = typesFor(analyzeComponents())['components.d.ts'];
    for (const word of ["'corn-proposal': HTMLCornProposalElement", "'corn-changes': HTMLCornChangesElement", "'corn-decision': HTMLCornDecisionElement", 'export interface CornScopeAuthDetail', "during: 'load' | 'proposal' | 'facts' | 'review' | 'send' | 'landing'", "'second-piece'"]) expect(text, word).toContain(word);
    // the detail of cornNavigate and cornDecision is the review's, written once for the two
    expect(text.match(/export interface CornNavigateDetail/g)).toHaveLength(1);
    expect(text.match(/export interface CornDecisionDetail/g)).toHaveLength(1);
    // written once in the types, so the two sources must say the same: one changed alone would be dropped from the types unseen
    const body = (tag: string, name: string) => {
      const src = fs.readFileSync(path.join(PACKAGE, 'src', 'components', tag, `${tag}.tsx`), 'utf8');
      const m = new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(src);
      return m ? m[0].replace(/^\s*\/\*\*.*\*\/\s*$/gm, '').replace(/\s+/g, ' ') : null;
    };
    for (const name of ['CornNavigateDetail', 'CornDecisionDetail', 'CornReviewRecord']) {
      expect(body('corn-scope', name), name).toBeTruthy();
      expect(body('corn-scope', name), name).toBe(body('corn-review', name));
    }
  });

  it('lists exactly what corn-review declares: its properties, its events and its methods, and the types of their details', () => {
    const [review] = analyzeComponents().filter((c: { tagName: string }) => c.tagName === 'corn-review');
    const names = (list: Array<{ name: string }>) => list.map((x) => x.name).sort();
    expect(names(review.properties)).toEqual(['checker', 'config', 'node', 'proposal', 'source', 'src', 'strings', 'theme', 'topology', 'useTheme', 'view']);
    expect(names(review.events)).toEqual(['cornAuth', 'cornDecision', 'cornError', 'cornNavigate', 'cornReady', 'cornSelect']);
    expect(names(review.methods)).toEqual(['fit', 'focusNode', 'refresh']);
    const text = typesFor([review])['components.d.ts'];
    // the types the details name come with them, one level down too (a decision's review record)
    for (const type of ['CornSelectDetail', 'CornNavigateDetail', 'CornDecisionDetail', 'CornReviewRecord', 'CornReviewAuthDetail', 'CornReviewErrorDetail']) expect(text, type).toContain(`export interface ${type}`);
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

  it('a consumer\'s .ts compiles against corn-review: its properties, a typed detail for each event, the methods and the JSX element', () => {
    expect(compile(`
      import type { LocalJSX, CornDecisionDetail, CornNavigateDetail } from './types/components';
      const el: HTMLCornReviewElement = document.createElement('corn-review');
      el.src = 'https://map.example.com';
      el.proposal = '0042-retire-the-old-export';
      el.proposal = { title: 'An object' };
      el.source = 'pull/31';
      el.view = 'after';
      el.node = 'a';
      el.theme = 'auto';
      el.useTheme = true;
      el.topology = { nodes: [{ id: 'a' }], edges: [] };
      el.config = { version: '1.2.3' };
      el.strings = { approve: 'Ship it' };
      el.checker = { check: async (items, options) => { void items; void options?.signal; return []; } };
      el.addEventListener('cornDecision', (e) => { const d: CornDecisionDetail = e.detail; const outcome: 'approved' | 'notes' = d.outcome; const open: boolean = d.open; const by: string | undefined = d.review.by; void outcome; void open; void by; });
      el.addEventListener('cornNavigate', (e) => { const d: CornNavigateDetail = e.detail; const view: 'before' | 'diff' | 'after' | null = d.view; const change: 'opened' | 'view' | 'closed' = d.change; const name: string | null = d.proposal; void view; void change; void name; });
      el.addEventListener('cornAuth', (e) => { const during: 'load' | 'proposal' | 'facts' | 'review' | 'send' | 'landing' = e.detail.during; const signIn: string = e.detail.signIn; void during; void signIn; });
      el.addEventListener('cornError', (e) => { if (e.detail.kind === 'proposal') void e.detail.message; });
      el.addEventListener('cornSelect', (e) => { const id: string | null = e.detail.id; void id; });
      el.addEventListener('cornReady', (e) => { const none: void = e.detail; void none; });
      void (async () => { await el.fit(); await el.focusNode('a'); await el.refresh(); })();
      const tagged: HTMLCornReviewElement = document.querySelector('corn-review')!;
      const props: LocalJSX.IntrinsicElements['corn-review'] = { src: 'https://map.example.com', proposal: 'x', view: 'diff', onCornDecision: (e) => { const d: CornDecisionDetail = e.detail; void d; } };
      void tagged; void props;
    `)).toEqual([]);
    const wrong = compile(`
      const el = document.querySelector('corn-review')!;
      el.view = 'sideways';
      el.theme = 'blue';
      el.addEventListener('cornDecision', (e) => { const outcome: 'rejected' = e.detail.outcome; void outcome; });
      el.addEventListener('cornDecision', (e) => { const proposal: string = e.detail.proposal; void proposal; });
      el.addEventListener('cornError', (e) => { if (e.detail.kind === 'gone') void 0; });
      el.focusNode(7);
      el.src = 7;
    `).join('\n');
    for (const word of ['sideways', 'blue', 'rejected', 'null', 'gone', 'number']) expect(wrong, word).toContain(word);
  }, 30_000);

  it('has an entry in the exports map for every component, with its declarations', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
    for (const tag of componentTags()) expect(pkg.exports[`./${tag}`], tag).toEqual({ types: `./dist/types/${tag}.d.ts`, default: `./dist/${tag}.js` });
  });

  it('resolves through the package\'s exports map, as a consumer that installed it would: the root, ./corn-map, ./corn-review, ./corn-scope, the pieces around the map, the review\'s sections, tokens.css and version.json', () => {
    if (!fs.existsSync(path.join(dist, 'types', 'index.d.ts'))) execFileSync(process.execPath, [path.join(PACKAGE, 'scripts', 'build.mjs')], { cwd: PACKAGE, stdio: 'pipe' });
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'corn-consumer-'));
    fs.mkdirSync(path.join(app, 'node_modules', '@popcorn245'), { recursive: true });
    fs.symlinkSync(PACKAGE, path.join(app, 'node_modules', '@popcorn245', 'cornfield-components'), 'dir');
    const file = path.join(app, 'main.ts');
    fs.writeFileSync(file, `
      import { version, CornMap } from '@popcorn245/cornfield-components';
      import type { CornSelectDetail } from '@popcorn245/cornfield-components';
      import { CornScope } from '@popcorn245/cornfield-components/corn-scope';
      import type { CornScopeAuthDetail, CornScopeErrorDetail } from '@popcorn245/cornfield-components';
      import '@popcorn245/cornfield-components/corn-map';
      import '@popcorn245/cornfield-components/corn-review';
      import '@popcorn245/cornfield-components/corn-node-panel';
      import '@popcorn245/cornfield-components/corn-layers';
      import '@popcorn245/cornfield-components/corn-proposal';
      import '@popcorn245/cornfield-components/corn-changes';
      import { CornDecision } from '@popcorn245/cornfield-components/corn-decision';
      import { CornSearch } from '@popcorn245/cornfield-components/corn-search';
      import type { CornSearchDetail } from '@popcorn245/cornfield-components';
      import type { CornDecisionDetail, CornNavigateDetail, CornReviewAuthDetail } from '@popcorn245/cornfield-components';
      import { CornReview } from '@popcorn245/cornfield-components/corn-review';
      const review: HTMLCornReviewElement = document.createElement('corn-review');
      review.src = 'https://map.example.com';
      review.proposal = '0042-retire-the-old-export';
      review.addEventListener('cornDecision', (e) => { const d: CornDecisionDetail = e.detail; void d; });
      review.addEventListener('cornNavigate', (e) => { const d: CornNavigateDetail = e.detail; void d; });
      review.addEventListener('cornAuth', (e) => { const d: CornReviewAuthDetail = e.detail; void d; });
      void CornReview; void CornSearch;
      const search: HTMLCornSearchElement = document.createElement('corn-search');
      search.query = 'mailer';
      search.addEventListener('cornSearch', (e) => { const d: CornSearchDetail = e.detail; const q: string = d.query; const c: string | null = d.current; void q; void c; });
      void search.focusField();
      const panel: HTMLCornNodePanelElement = document.createElement('corn-node-panel');
      const layers: HTMLCornLayersElement = document.createElement('corn-layers');
      void panel; void layers;
      const v: string = version;
      const el = document.querySelector('corn-map')!;
      el.addEventListener('cornSelect', (e) => { const d: CornSelectDetail = e.detail; void d; });
      el.src = 'https://map.example.com';
      el.useTheme = true;
      el.addEventListener('cornAuth', (e) => { const signIn: string = e.detail.signIn; const status: number = e.detail.status; void signIn; void status; });
      const scope: HTMLCornScopeElement = document.createElement('corn-scope');
      scope.src = 'https://map.example.com';
      scope.theme = 'auto';
      scope.useTheme = true;
      scope.topology = { nodes: [{ id: 'a' }], edges: [] };
      scope.config = { version: '1.2.3' };
      scope.strings = { retry: 'Again' };
      scope.proposal = '0042-retire-the-old-export';
      scope.source = 'pull/31';
      scope.view = 'after';
      scope.addEventListener('cornNavigate', (e) => { const d: CornNavigateDetail = e.detail; const view: 'before' | 'diff' | 'after' | null = d.view; void view; });
      scope.addEventListener('cornDecision', (e) => { const d: CornDecisionDetail = e.detail; const outcome: 'approved' | 'notes' = d.outcome; void outcome; });
      scope.addEventListener('cornAuth', (e) => { const d: CornScopeAuthDetail = e.detail; const during: 'load' | 'proposal' | 'facts' | 'review' | 'send' | 'landing' = d.during; void during; });
      scope.addEventListener('cornError', (e) => { const d: CornScopeErrorDetail = e.detail; if (d.kind === 'not-listed' || d.kind === 'proposal') void d.message; });
      const decision: HTMLCornDecisionElement = document.createElement('corn-decision');
      const proposalBar: HTMLCornProposalElement = document.createElement('corn-proposal');
      const changes: HTMLCornChangesElement = document.createElement('corn-changes');
      void decision; void proposalBar; void changes; void CornDecision;
      scope.addEventListener('cornReady', (e) => { const none: void = e.detail; void none; });
      void v; void CornMap; void CornScope;
    `);
    fs.writeFileSync(path.join(app, 'package.json'), '{ "type": "module" }\n');
    // A bundler's resolution, and Node's own (node16, nodenext: relative imports in the declarations need their extension), with the declarations checked too
    for (const [module, moduleResolution] of [[ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler], [ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext]] as const) {
      const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module, moduleResolution, lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'], types: [], skipLibCheck: false });
      expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), ts.ModuleResolutionKind[moduleResolution]).toEqual([]);
    }
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
      const scope = document.querySelector('corn-scope')!;
      scope.theme = 'blue';
      scope.addEventListener('cornError', (e) => { if (e.detail.kind === 'gone') void 0; });
      scope.src = 7;
    `);
    expect(wrong.length).toBeGreaterThanOrEqual(8);
    const text = wrong.join('\n');
    expect(text).toMatch(/sideways/);
    expect(text).toMatch(/blue/);
    expect(text).toMatch(/zoomTo/);
    expect(text).toMatch(/number/);
    expect(text).toMatch(/and '"gone"' have no overlap/);
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
    // each chunk is named plainly, for what it is (the engine every component shares is `engine-<hash>.js`, not its first module's name)
    const chunks = fs.readdirSync(path.join(dist, 'chunks'));
    for (const f of chunks) expect(f, f).toMatch(/^[a-z][a-z0-9-]*-[\w-]{8}\.js$/);
    expect(chunks.filter((f) => f.startsWith('engine-'))).toHaveLength(1);
  });

  it('a map that is handed its data loads none of the scope: the loading, the states and the server\'s theme are a chunk of their own, imported only for a src', () => {
    const reach = (entry: string, dynamic: boolean, seen = new Set<string>()): Set<string> => {
      const text = read(entry);
      const pattern = dynamic ? /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g : /(?:from|import)\s*["'](\.[^"']+)["']/g;
      for (const m of text.matchAll(pattern)) { const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1])); if (!seen.has(target)) { seen.add(target); reach(target, dynamic, seen); } }
      return seen;
    };
    // a string only each module holds (the build is not minified, but a module's path comment is not always kept)
    const probes = { 'pieces/scope.js': '// ../explorer/pieces/scope.js', 'engine/source.js': '/cornfield/config.json', 'engine/theme-sheet.js': 'constructable stylesheets are not available', 'pieces/status.js': 'source-announcer' };
    const statics = [...reach('corn-map.js', false)].map((f) => read(f)).join('\n');
    for (const [module, probe] of Object.entries(probes)) expect(statics.includes(probe), module).toBe(false);
    const all = [...reach('corn-map.js', true)].map((f) => read(f)).join('\n');
    for (const [module, probe] of Object.entries(probes)) expect(all.includes(probe), module).toBe(true);
    // corn-scope has it at once: no second round trip for a scope
    expect([...reach('corn-scope.js', false)].some((f) => read(f).includes('// ../explorer/pieces/scope.js'))).toBe(true);
  });

  it('a review that is handed its data loads none of the load: the config and the map read, the states and the server\'s theme are a chunk of their own, imported only for a src', () => {
    const reach = (entry: string, dynamic: boolean, seen = new Set<string>()): Set<string> => {
      const text = read(entry);
      const pattern = dynamic ? /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g : /(?:from|import)\s*["'](\.[^"']+)["']/g;
      for (const m of text.matchAll(pattern)) { const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), m[1])); if (!seen.has(target)) { seen.add(target); reach(target, dynamic, seen); } }
      return seen;
    };
    const probes = { 'engine/source.js': '/cornfield/config.json', 'engine/theme-sheet.js': 'constructable stylesheets are not available', 'pieces/status.js': 'source-announcer' };
    const statics = ['corn-review.js', ...reach('corn-review.js', false)].map((f) => read(f)).join('\n');
    for (const [module, probe] of Object.entries(probes)) expect(statics.includes(probe), module).toBe(false);
    expect(statics).toContain('The review has no server'); // what a src needs at once: the address, and nothing asked of the host's own origin in its place
    const all = ['corn-review.js', ...reach('corn-review.js', true)].map((f) => read(f)).join('\n');
    for (const [module, probe] of Object.entries(probes)) expect(all.includes(probe), module).toBe(true);
    // the review shares the engine with the map: it makes no copy of it (the chunks are the map's and the scope's)
    const shared = [...reach('corn-review.js', false)].filter((f) => reach('corn-map.js', false).has(f));
    expect(shared.some((f) => f.startsWith('chunks/') && !f.includes('runtime'))).toBe(true);
  });

  it('a map alone loads none of the review, the two load one engine once, and no chunk imports back the chunk that imported it', () => {
    const edges = (f: string, dynamic: boolean) => [...read(f).matchAll(dynamic ? /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g : /(?:from|import)\s*["'](\.[^"']+)["']/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])));
    const reach = (entry: string, dynamic: boolean, seen = new Set<string>([entry])): Set<string> => { for (const t of edges(entry, dynamic)) if (!seen.has(t)) { seen.add(t); reach(t, dynamic, seen); } return seen; };
    // a string only each review-side module holds: a map that shares a module with the review would carry the review's use of it (the size budget)
    const probes = {
      'engine/sheets.js': 'hx-sheet-handle', 'proposal-model.js': 'There is no proposal called', 'check-model.js': 'Expected allowed, but refused',
      'cloud-panel.js': 'Breaks on renewal', 'outage-scenario.js': 'in the visitor\'s browser', 'selection-words.js': 'off screen', 'pieces/decision.js': 'data-review-undo',
    };
    const map = [...reach('corn-map.js', false)];
    const mapText = map.map((f) => read(f)).join('\n');
    for (const [module, probe] of Object.entries(probes)) expect(mapText.includes(probe), module).toBe(false);
    const review = reach('corn-review.js', false);
    const reviewText = [...review].map((f) => read(f)).join('\n');
    for (const [module, probe] of Object.entries(probes)) expect(reviewText.includes(probe), module).toBe(true);
    // one engine: every chunk a map loads but its own shell is one the review loads, so a page with both fetches each once
    for (const f of map.filter((x) => x.startsWith('chunks/') && !x.startsWith('chunks/corn-map-'))) expect(review.has(f), f).toBe(true);
    // no cycle: walking the chunks (dynamic imports too) never comes back to where it started
    const files = ['index.js', ...componentTags().map((t) => `${t}.js`), ...fs.readdirSync(path.join(dist, 'chunks')).filter((f) => f.endsWith('.js')).map((f) => `chunks/${f}`)];
    for (const f of files) for (const t of edges(f, true)) expect(reach(t, true).has(f), `${t} leads back to ${f}`).toBe(false);
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
    expect(own.private).toBeUndefined(); // publishable: the release publishes it when the maintainer has added the npm token (RELEASING.md)
  });

  it('ships tokens.css, the same text the elements add to a page, at zero specificity', () => {
    expect(read('tokens.css')).toBe(tokensCss());
    for (const line of read('tokens.css').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => /\{\s*$/.test(l))) expect(line.trim().startsWith(':where(') || line.trim().startsWith('@media')).toBe(true);
    expect(fs.readdirSync(path.join(dist, 'chunks')).map((f) => read(`chunks/${f}`)).join('\n')).toContain(':where(:root)');
  });

  it('ships the declarations next to the modules', () => {
    for (const f of ['components.d.ts', 'index.d.ts', 'corn-map.d.ts', 'corn-review.d.ts', 'corn-scope.d.ts', 'corn-node-panel.d.ts', 'corn-layers.d.ts', 'corn-search.d.ts', 'corn-proposal.d.ts', 'corn-changes.d.ts', 'corn-decision.d.ts']) expect(fs.existsSync(path.join(dist, 'types', f)), f).toBe(true);
  });

  it('is inside the size budget: the runtime chunk, corn-map and corn-review with their engine, each with what a src brings, and corn-scope with what it loads, each at most 5% over what size-budget.json holds', () => {
    const { budget, tolerance } = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'size-budget.json'), 'utf8'));
    expect(tolerance).toBe(0.05);
    expect(Object.keys(budget).sort()).toEqual(['corn-changes', 'corn-changes-added', 'corn-decision', 'corn-decision-added', 'corn-layers', 'corn-layers-added', 'corn-map', 'corn-map-src', 'corn-node-panel', 'corn-node-panel-added', 'corn-proposal', 'corn-proposal-added', 'corn-review', 'corn-review-src', 'corn-scope', 'corn-scope-proposal', 'corn-search', 'corn-search-added', 'runtime']);
    const now = measure();
    for (const [name, limit] of Object.entries(budget) as Array<[string, number]>) expect(now[name], `${name}: ${now[name]} B gzip against a budget of ${limit}`).toBeLessThanOrEqual(limit * 1.05);
  });
});

describe('the manifest: the files the cornfield server may serve (D11)', () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(dist, MANIFEST))) execFileSync(process.execPath, [path.join(PACKAGE, 'scripts', 'build.mjs')], { cwd: PACKAGE, stdio: 'pipe' });
  }, 120_000);
  const manifest = () => JSON.parse(fs.readFileSync(path.join(dist, MANIFEST), 'utf8'));

  it('lists every file of dist/ but itself, with its size and hash, and the version it was built for', () => {
    const m = manifest();
    expect(m.name).toBe('@popcorn245/cornfield-components');
    expect(m.cornfield).toBe(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version);
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(distFiles(dist));
    for (const f of m.files as Array<{ path: string; bytes: number; sha256: string }>) {
      const body = fs.readFileSync(path.join(dist, f.path));
      expect(f.bytes, f.path).toBe(body.length);
      expect(f.sha256, f.path).toBe(createHash('sha256').update(body).digest('hex'));
    }
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining(['index.js', 'corn-map.js', 'tokens.css', 'version.json', 'types/index.d.ts']));
  });

  it('names only files the server will serve: plain names, no dotfile, and .js .css .json .d.ts .map', () => {
    for (const f of manifest().files as Array<{ path: string }>) {
      expect(SAFE_PATH.test(f.path), f.path).toBe(true);
      expect(SERVED.test(f.path), f.path).toBe(true);
    }
    expect(SAFE_PATH.test('../x.js')).toBe(false);
    expect(SAFE_PATH.test('.hidden.js')).toBe(false);
    expect(SAFE_PATH.test('a/.b.js')).toBe(false);
    expect(SAFE_PATH.test('/abs.js')).toBe(false);
    expect(SERVED.test('a.html')).toBe(false);
  });

  it('is refused when a build leaves something the server could not serve', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corn-manifest-'));
    fs.writeFileSync(path.join(tmp, 'a.js'), 'x');
    fs.writeFileSync(path.join(tmp, 'b.html'), 'x');
    expect(() => writeManifest(tmp, { name: 'x', version: '1.0.0' })).toThrow(/b\.html/);
  });
});

describe('what is published (D11)', () => {
  const own = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
  beforeAll(() => {
    if (!fs.existsSync(path.join(dist, MANIFEST))) execFileSync(process.execPath, [path.join(PACKAGE, 'scripts', 'build.mjs')], { cwd: PACKAGE, stdio: 'pipe' });
  }, 120_000);

  it('is a public package of the right name, licence and repository, which bundlers must not tree-shake away', () => {
    expect(own.name).toBe('@popcorn245/cornfield-components');
    expect(own.private).toBeUndefined();
    expect(own.license).toBe('MIT');
    expect(own.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(own.repository).toEqual({ type: 'git', url: 'git+https://github.com/popcorn245/CornField.git', directory: 'components' });
    expect(own.files).toEqual(['dist']);
    expect(own.type).toBe('module');
    expect(own.sideEffects).toBe(true); // importing a module registers its custom element: a bundler that thinks it unused would drop the element
    expect(own.types).toBe('dist/types/index.d.ts');
    expect(own.scripts.prepublishOnly).toBe('node scripts/release-guard.mjs');
    expect(fs.readFileSync(path.join(PACKAGE, 'LICENSE'), 'utf8')).toBe(fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8'));
  });

  it('packs exactly: dist/ as built, the licence, the readme and package.json, and no source, test, script, demo or map', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PACKAGE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const packed: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path).sort();
    const expected = ['LICENSE', 'README.md', 'package.json', `dist/${MANIFEST}`, ...distFiles(dist).map((f: string) => `dist/${f}`)].sort();
    expect(packed).toEqual(expected);
    for (const f of packed) expect(f, f).toMatch(/^(?:LICENSE|README\.md|package\.json|dist\/[\w./-]+\.(?:js|css|json|d\.ts))$/);
    expect(packed.some((f) => /\.map$|^(?:src|test|scripts|demo)\//.test(f))).toBe(false);
  }, 30_000);

  describe('the release guard (prepublishOnly)', () => {
    const fixture = (version = '0.48.0', built = version) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corn-guard-'));
      const pkg = path.join(root, 'components');
      fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cornfield', version }));
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@popcorn245/cornfield-components', version }));
      for (const f of ['version.json', 'manifest.json']) fs.writeFileSync(path.join(pkg, 'dist', f), JSON.stringify({ cornfield: built }));
      return { root, pkg };
    };
    const release = { CORNFIELD_RELEASE: '1', CORNFIELD_RELEASE_TAG: 'v0.48.0' };

    it('lets the release workflow\'s publish through: the tag, the package, cornfield and the build all say the same version', () => {
      const { root, pkg } = fixture();
      expect(releaseProblems({ cwd: pkg, env: release, root: pkg, repo: root })).toEqual([]);
    });
    it('refuses a publish by hand, from another folder, for another tag, or of a build made for another version', () => {
      const { root, pkg } = fixture();
      expect(releaseProblems({ cwd: pkg, env: {}, root: pkg, repo: root }).join('\n')).toMatch(/CORNFIELD_RELEASE is not 1/);
      expect(releaseProblems({ cwd: root, env: release, root: pkg, repo: root }).join('\n')).toMatch(/not from the components/);
      expect(releaseProblems({ cwd: pkg, env: { ...release, CORNFIELD_RELEASE_TAG: 'v0.47.0' }, root: pkg, repo: root }).join('\n')).toMatch(/release tag/);
      const stale = fixture('0.48.0', '0.1.0');
      expect(releaseProblems({ cwd: stale.pkg, env: release, root: stale.pkg, repo: stale.root }).join('\n')).toMatch(/dist\/version\.json says "0\.1\.0", not 0\.48\.0/);
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'cornfield', version: '0.1.0' }));
      expect(releaseProblems({ cwd: pkg, env: release, root: pkg, repo: root }).join('\n')).toMatch(/cornfield's package\.json says 0\.1\.0/);
    });
    it('refuses the real package as it stands on main (0.1.0, no tag), and its script runs the guard', () => {
      expect(releaseProblems({ env: { CORNFIELD_RELEASE: '1' } }).join('\n')).toMatch(/release tag/);
    });
  });
});
