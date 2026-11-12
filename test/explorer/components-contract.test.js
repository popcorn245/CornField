/**
 * @vitest-environment node
 *
 * Spec 0011 D12: the tags, properties, attributes, events, methods and parts of the web components, and the `theme` attribute's values, are public
 * contract, listed in docs/theming.md "Web components". This reads the components' source (components/src/components/<tag>/<tag>.tsx, as text: the
 * root suite needs nothing from components/ installed) and the pieces' source, and fails when the docs and the code disagree, in either direction.
 * It also holds D1: the root package takes no dependency and no build step for the components.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CORNFIELD, EXPLORER } from '../helpers.js';

const docs = fs.readFileSync(path.join(CORNFIELD, 'docs', 'theming.md'), 'utf8');
const section = docs.slice(docs.indexOf('## Web components'), docs.indexOf('\n## Words'));
const sub = (title) => { const at = section.indexOf(`### ${title}`); return section.slice(at, section.indexOf('\n### ', at + 5) < 0 ? undefined : section.indexOf('\n### ', at + 5)); };
/** The rows of a table: arrays of cells (a leading and trailing bar removed), without the header and the rule */
const rows = (text) => text.split('\n').filter((l) => l.startsWith('|')).slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
const ticked = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const dir = path.join(CORNFIELD, 'components', 'src', 'components');
const tags = fs.readdirSync(dir).map((name) => {
  const text = fs.readFileSync(path.join(dir, name, `${name}.tsx`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return {
    tag: /tag:\s*'([^']+)'/.exec(text)[1],
    shadow: /encapsulation:\s*\{\s*type:\s*'shadow'/.test(text),
    props: [...text.matchAll(/@Prop\(([^)]*)\)\s*(\w+)\s*(\?)?:\s*([^;=]+?)\s*(?:=[^;]*)?;/g)].map((m) => ({ name: m[2], options: m[1], type: m[4] })),
    events: [...text.matchAll(/@Event\(\)\s*(\w+)!?:/g)].map((m) => m[1]),
    methods: [...text.matchAll(/@Method\(\)\s*async\s+(\w+)\(/g)].map((m) => m[1]),
    text,
  };
});

describe('the documented components', () => {
  it('lists every tag the package has, and says whether it has a shadow root', () => {
    expect(tags.length).toBeGreaterThan(0);
    const documented = rows(sub('Tags'));
    expect(documented.map((r) => ticked(r[0])[0]).sort()).toEqual(tags.map((t) => t.tag).sort());
    for (const t of tags) expect(documented.find((r) => ticked(r[0])[0] === t.tag)[1]).toBe(t.shadow ? 'yes' : 'no');
    for (const t of tags) expect(t.tag).toMatch(/^corn-[a-z]+(-[a-z]+)*$/);
  });

  it('lists every property, with its attribute (none for an object), and nothing else', () => {
    const documented = rows(sub('Properties'));
    for (const t of tags) {
      const mine = documented.filter((r) => ticked(r[0])[0] === t.tag);
      expect(mine.map((r) => ticked(r[1])[0]).sort(), t.tag).toEqual(t.props.map((p) => p.name).sort());
      for (const p of t.props) {
        const row = mine.find((r) => ticked(r[1])[0] === p.name);
        const object = /[{}]|Array/.test(p.type);
        if (object) expect(row[2], p.name).toBe('none');
        else expect(ticked(row[2])[0], p.name).toBe(p.name);
        expect(/reflect:\s*true/.test(p.options), `${t.tag} ${p.name} reflected`).toBe(/reflected/.test(row[2]));
      }
    }
  });

  it('documents every value of a property that is a choice', () => {
    const documented = rows(sub('Properties'));
    for (const t of tags) for (const p of t.props) {
      const words = [...p.type.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
      if (!words.length) continue;
      const row = documented.find((r) => r[0].includes(`\`${t.tag}\``) && ticked(r[1])[0] === p.name);
      expect(ticked(row[3]).sort(), `${t.tag} ${p.name}`).toEqual([...new Set(words)].sort());
    }
  });

  it('lists every event, and every method, and nothing else', () => {
    const events = rows(sub('Events'));
    const methods = rows(sub('Methods'));
    for (const t of tags) {
      expect(events.filter((r) => ticked(r[0])[0] === t.tag).map((r) => ticked(r[1])[0]).sort(), `${t.tag} events`).toEqual([...t.events].sort());
      expect(methods.filter((r) => ticked(r[0])[0] === t.tag).map((r) => ticked(r[1])[0].replace(/\(.*$/, '')).sort(), `${t.tag} methods`).toEqual([...t.methods].sort());
      for (const e of t.events) expect(e, e).toMatch(/^corn[A-Z]/); // events are prefixed `corn` (spec 0011 question 6)
    }
    expect(section).toMatch(/All three answer with a promise/);
  });

  it('events cross the shadow root, as documented: the sources keep Stencil\'s defaults for bubbles and composed', () => {
    for (const t of tags) expect(/@Event\(\s*\{[^}]*(bubbles|composed):\s*false/.test(t.text), t.tag).toBe(false);
    expect(section).toMatch(/bubble and cross the shadow root \(`composed`\)/);
  });

  it('lists every part: exactly the hooks the piece makes (each is a part of the same name)', () => {
    const piece = fs.readFileSync(path.join(EXPLORER, 'pieces', 'map.js'), 'utf8');
    const renderer = fs.readFileSync(path.join(EXPLORER, 'renderer.js'), 'utf8');
    const made = [...piece.matchAll(/\bdata-corn="([a-z0-9-]+)"/g)].map((m) => m[1]); // its markup and its stage: each hook gets its part when placed (engine/piece.js)
    const stand = /setAttribute\('data-corn', '(map-overlay)'\)/.exec(renderer)[1]; // the second renderer's stand-in canvas
    const parts = rows(sub('Parts')).find((r) => ticked(r[0])[0] === 'corn-map');
    expect(ticked(parts[1]).sort()).toEqual([...new Set([...made, stand])].sort());
  });

  it('documents the theme attribute\'s values, and the component says them the same', () => {
    expect(section).toMatch(/`theme="light"` or `theme="dark"` forces that mode/);
    const map = tags.find((t) => t.tag === 'corn-map');
    expect([...map.props.find((p) => p.name === 'theme').type.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()).toEqual(['auto', 'dark', 'light']);
    // and the stylesheet the package generates declares each forced mode for each tag (components/scripts/tokens.mjs)
    const generator = fs.readFileSync(path.join(CORNFIELD, 'components', 'scripts', 'tokens.mjs'), 'utf8');
    expect(generator).toContain('[theme="${mode}"]');
  });
});

describe('the root package takes nothing from the components (D1)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CORNFIELD, 'package.json'), 'utf8'));
  const names = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies].flatMap((d) => Object.keys(d || {}));

  it('has no dependency on StencilRS, Stencil, Vite, Playwright or the components, and no build script', () => {
    expect(names.filter((n) => /^(vite$|@stencil\/|@popcorn245\/|playwright|@vitest\/browser|typescript$)/.test(n))).toEqual([]);
    expect(Object.keys(pkg.scripts).filter((s) => /build|components/.test(s))).toEqual([]);
    expect(pkg.workspaces).toBeUndefined();
  });

  it('does not ship them: the package files and the image are what they were', () => {
    expect(pkg.files).toEqual(['cli/', 'core/', 'explorer/', 'plugins/', 'server/', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    const dockerfile = fs.readFileSync(path.join(CORNFIELD, 'Dockerfile'), 'utf8');
    expect(dockerfile).not.toMatch(/components/);
  });

  it('runs the root suite without components/ installed: its tests are not collected', () => {
    const config = fs.readFileSync(path.join(CORNFIELD, 'vitest.config.js'), 'utf8');
    expect(config).toMatch(/include:\s*\['test\/\*\*\/\*\.test\.js'\]/);
    expect(config).toContain("'components/**'");
  });

  it('the components are a package of their own: private for now, its own lockfile, pinned versions', () => {
    const own = JSON.parse(fs.readFileSync(path.join(CORNFIELD, 'components', 'package.json'), 'utf8'));
    expect(own.name).toBe('@popcorn245/cornfield-components');
    expect(own.private).toBe(true);
    expect(fs.existsSync(path.join(CORNFIELD, 'components', 'package-lock.json'))).toBe(true);
    for (const [name, version] of Object.entries({ ...own.devDependencies, ...own.dependencies })) expect(version, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/); // exact, as the StencilRS starter pins them
    expect(own.devDependencies['@popcorn245/stencilrs']).toBeTruthy();
    expect(own.devDependencies['@stencil/core']).toBe('5.0.0-beta.25');
  });
});
