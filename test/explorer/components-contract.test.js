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
        const object = /[{}]|Array/.test(p.type) && !/^string\b/.test(p.type); // `proposal` is a name or an object: it has the attribute for the name
        const attribute = p.name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`); // Stencil dash-cases a camelCase property (`useTheme` is `use-theme`)
        if (object) expect(row[2], p.name).toBe('none');
        else expect(ticked(row[2])[0], p.name).toBe(attribute);
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
    expect(section).toMatch(/All of them answer with a promise/);
  });

  it('lists every field of an event\'s detail, and no other, here and in docs/embedding.md', () => {
    const embedding = fs.readFileSync(path.join(CORNFIELD, 'docs', 'embedding.md'), 'utf8');
    /** The fields a cell names: the ticked words between "Its fields:" and the next full stop */
    const fieldsIn = (cell) => { const m = /Its fields: ([^.]*)\./.exec(cell); return m ? ticked(m[1]).sort() : null; };
    for (const t of tags) {
      for (const m of t.text.matchAll(/@Event\(\)\s*(\w+)!?:\s*EventEmitter<(\w+)>/g)) {
        const [, event, type] = m;
        if (type === 'void') continue;
        const decl = new RegExp(`export interface ${type} \\{([^}]*)\\}`).exec(t.text);
        expect(decl, `${t.tag} ${event}: ${type} is declared in the component's file`).toBeTruthy();
        const fields = [...decl[1].matchAll(/^\s*(\w+)\??:/gm)].map((f) => f[1]).sort();
        const row = rows(sub('Events')).find((r) => ticked(r[0])[0] === t.tag && ticked(r[1])[0] === event);
        expect(fieldsIn(row[2]), `${t.tag} ${event} in theming.md`).toEqual(fields);
        // the same event name is on more than one tag (`cornAuth`): its table row in embedding.md is the one whose fields these are
        const lines = embedding.split('\n').filter((l) => l.startsWith(`| \`${event}\` |`));
        expect(lines.map(fieldsIn), `${t.tag} ${event} in embedding.md`).toContainEqual(fields);
      }
    }
  });

  it('events cross the shadow root, as documented: the sources keep Stencil\'s defaults for bubbles and composed', () => {
    for (const t of tags) expect(/@Event\(\s*\{[^}]*(bubbles|composed):\s*false/.test(t.text), t.tag).toBe(false);
    expect(section).toMatch(/bubble and cross the shadow root \(`composed`\)/);
  });

  it('lists every part: exactly the hooks the piece makes (each is a part of the same name)', () => {
    // the map piece's own markup, and the status box it mounts (pieces/status.js): the parts of `corn-map` with a source
    const piece = ['map.js', 'status.js'].map((f) => fs.readFileSync(path.join(EXPLORER, 'pieces', f), 'utf8')).join('\n');
    const renderer = fs.readFileSync(path.join(EXPLORER, 'renderer.js'), 'utf8');
    const made = [...piece.matchAll(/\bdata-corn="([a-z0-9-]+)"/g)].map((m) => m[1]); // its markup and its stage: each hook gets its part when placed (engine/piece.js)
    const stand = /setAttribute\('data-corn', '(map-overlay)'\)/.exec(renderer)[1]; // the second renderer's stand-in canvas
    const parts = rows(sub('Parts')).find((r) => ticked(r[0])[0] === 'corn-map');
    expect(ticked(parts[1]).sort()).toEqual([...new Set([...made, stand])].sort());
  });

  it('lists every part of corn-review: exactly the hooks of the modules its piece reaches (each is a part of the same name)', () => {
    // pieces/review.js and every module it imports, statically or by `import()` (the load a `src` brings is one): the map, the status card, the node panel, the
    // proposal's bar, the change list with the player, the decision and what they make their markup from
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file) || !fs.existsSync(file)) return;
      seen.add(file);
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+\.js)['"]/g)) walk(path.resolve(path.dirname(file), m[1]));
    };
    walk(path.join(EXPLORER, 'pieces', 'review.js'));
    expect([...seen].map((f) => path.relative(EXPLORER, f))).toEqual(expect.arrayContaining(['pieces/map.js', 'pieces/status.js', 'pieces/node-panel.js', 'pieces/proposal.js', 'pieces/changes.js', 'pieces/decision.js', 'engine/player.js', 'pieces/review-source.js']));
    const made = new Set([...seen].flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\bdata-corn=\\?"([a-z0-9-]+)\\?"/g)].map((m) => m[1])));
    made.add('map-overlay'); // the second renderer's stand-in canvas (renderer.js)
    const parts = rows(sub('Parts')).find((r) => ticked(r[0])[0] === 'corn-review');
    expect(ticked(parts[1]).sort()).toEqual([...made].sort());
    // it is the one the review's own state of the box names, and the three the host puts its hand on first
    for (const part of ['review', 'stage', 'dock', 'decision', 'review-bar', 'proposal-bar', 'proposal-title', 'review-column', 'node-panel', 'scenario-player', 'source-status', 'source-sign-in', 'empty']) expect(made.has(part), part).toBe(true);
  });

  it('lists every part of corn-node-panel, corn-layers and corn-search: the hooks of the piece and the modules that make its markup (each is a part of the same name)', () => {
    // what each piece makes in a box of its own (`inline`, no phone bar): the node panel has no dim layer, the search no phone bar, and the legend of the data-flow lines is the Layers menu's
    const PIECES = {
      'corn-node-panel': { files: ['pieces/node-panel.js', 'engine/flow-ui.js', 'proposal-model.js', 'mockups-model.js', 'cloud-panel.js', 'capped.js', 'selection-words.js', 'selection-view.js', 'pieces/around.js'], not: ['backdrop', 'menu-section', 'menu-title'] },
      'corn-layers': { files: ['pieces/layers.js', 'engine/flow-legend.js', 'edge-key.js', 'pieces/around.js'], not: [] },
      'corn-search': { files: ['pieces/search.js', 'pieces/around.js'], not: ['dialog-scrim', 'mobile-search', 'mobile-search-button'] },
    };
    for (const [tag, { files, not }] of Object.entries(PIECES)) {
      const made = new Set(files.flatMap((f) => [...fs.readFileSync(path.join(EXPLORER, f), 'utf8').matchAll(/\bdata-corn=\\?"([a-z0-9-]+)\\?"/g)].map((m) => m[1])));
      for (const hook of not) made.delete(hook);
      const parts = rows(sub('Parts')).find((r) => ticked(r[0])[0] === tag);
      expect(ticked(parts[1]).sort(), tag).toEqual([...made].sort());
      // the piece never reaches the page, and the tag's own file has no markup (it is a shell)
      const shell = fs.readFileSync(path.join(dir, tag, `${tag}.tsx`), 'utf8');
      expect(shell).toContain("explorer/pieces/around.js");
    }
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

  it('does not put them in cornfield\'s own npm package; the image gets only their build, from a builder stage (D11)', () => {
    expect(pkg.files).toEqual(['cli/', 'core/', 'explorer/', 'plugins/', 'server/', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    const dockerfile = fs.readFileSync(path.join(CORNFIELD, 'Dockerfile'), 'utf8');
    const lines = dockerfile.split('\n').filter((l) => !l.trim().startsWith('#'));
    const froms = lines.map((l, i) => [l, i]).filter(([l]) => /^FROM /.test(l));
    expect(froms.map(([l]) => l)).toEqual(['FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS components', 'FROM node:22-alpine']);
    // StencilRS publishes glibc binaries only (linux-x64-gnu, linux-arm64-gnu): on a musl base the build dies loading it (ERR_DLOPEN_FAILED, PR #245's
    // first image job). The builder runs on glibc, on the build machine's own platform (never emulated); the final image stays Alpine
    expect(froms[0][0]).not.toMatch(/alpine|musl|busybox|distroless|:\s*$/i);
    expect(froms[0][0]).toMatch(/^FROM --platform=\$BUILDPLATFORM node:22-(?:bookworm|trixie|bullseye)(?:-slim)? AS components$/);
    const builder = lines.slice(froms[0][1], froms[1][1]).join('\n');
    const final = lines.slice(froms[1][1]).join('\n');
    // the builder installs components/'s own dev dependencies from its own lockfile and builds
    expect(builder).toMatch(/COPY components\/package\.json components\/package-lock\.json/);
    expect(builder).toMatch(/cd components && npm ci /);
    expect(builder).toMatch(/cd components && npm run build/);
    // the final image takes the build's dist/ and nothing else of components/: no install, no sources, no node_modules
    expect(final.split('\n').filter((l) => /components/.test(l))).toHaveLength(1);
    expect(final).toMatch(/^COPY --from=components \/src\/components\/dist \.\/components\/dist$/m);
    expect(final).not.toMatch(/COPY components|cd components|npm run build/);
    expect(final).toMatch(/npm ci --omit=dev/);
    // the build context lets the builder see components/ sources, and neither node_modules nor a build
    const ignored = fs.readFileSync(path.join(CORNFIELD, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(ignored).not.toContain('components');
    expect(ignored).toEqual(expect.arrayContaining(['**/node_modules', 'components/dist']));
  });

  it('a checkout needs no build: the server answers the components\' route with a plain 404 when components/dist is not there (server/components.js)', () => {
    const server = fs.readFileSync(path.join(CORNFIELD, 'server', 'components.js'), 'utf8');
    expect(server).not.toMatch(/child_process|spawn|exec\(/);
    expect(server).toContain("npm run build");
  });

  it('is released under cornfield\'s version: the release builds them with it, stamps the package, and publishes only once armed: by NPM_TOKEN, or after a first publish by trusted publishing (D11)', () => {
    const workflow = fs.readFileSync(path.join(CORNFIELD, '.github', 'workflows', 'release.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('\n  components:\n'));
    // the version from the tag, in cornfield's package.json (what the build reads) and in the package, before the build; the build is checked against it
    expect(job.indexOf('npm version --no-git-tag-version')).toBeGreaterThan(0);
    expect((job.match(/npm version --no-git-tag-version --allow-same-version "\$\{VERSION\}"/g) || [])).toHaveLength(2);
    expect(job.indexOf('npm version')).toBeLessThan(job.indexOf('npm run build'));
    expect(job).toContain("require('./dist/version.json').cornfield");
    expect(job).toContain("require('./package.json').version");
    // permissions: what the npm job has, nothing more
    expect(job).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write[^\n]*\n\s+env:/);
    // the token lives in the environment of the publish step alone, under a name of its own (setup-node exports a placeholder NODE_AUTH_TOKEN), is
    // tested for emptiness, handed to npm only for the publish, and never echoed
    expect(job.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1); // this job names the secret once, on the publish step
    const publish = job.slice(job.indexOf('- name: Publish @popcorn245/cornfield-components'));
    expect(publish).toContain('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(publish).toMatch(/if \[ -z "\$\{NPM_TOKEN:-\}" \]; then\n/);
    expect(publish).toMatch(/\n\s+NODE_AUTH_TOKEN="\$\{NPM_TOKEN:-\}" npm publish --access public --provenance\n?$/);
    expect(job.replace(publish, '').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN:/);
    expect(job).not.toMatch(/echo[^\n]*\$\{?(NODE_AUTH_TOKEN|NPM_TOKEN)/);
    expect(job).not.toMatch(/set -[a-z]*x/);
    // unarmed (no token, a name never published) it says so and succeeds; a registry that cannot say fails rather than guess
    expect(publish).toMatch(/404\)\n\s+echo "NPM_TOKEN is not set[^\n]*\n\s+exit 0 ;;/);
    expect(publish).toMatch(/\*\) echo [^\n]*exit 1 ;;/);
    // the existing jobs and their outputs are as they were
    for (const name of ['check', 'version', 'image', 'npm']) expect(workflow).toContain(`\n  ${name}:\n`);
    expect(workflow).toContain('tag: ${{ steps.made.outputs.tag }}');
    expect(workflow).toContain('version: ${{ steps.made.outputs.version }}');
  });

  it('runs the root suite without components/ installed: its tests are not collected', () => {
    const config = fs.readFileSync(path.join(CORNFIELD, 'vitest.config.js'), 'utf8');
    expect(config).toMatch(/include:\s*\['test\/\*\*\/\*\.test\.js'\]/);
    expect(config).toContain("'components/**'");
  });

  it('the components are a package of their own: published under cornfield\'s version, its own lockfile, pinned versions', () => {
    const own = JSON.parse(fs.readFileSync(path.join(CORNFIELD, 'components', 'package.json'), 'utf8'));
    expect(own.name).toBe('@popcorn245/cornfield-components');
    expect(own.private).toBeUndefined();
    expect(own.version).toBe(pkg.version); // main holds the two equal; the release sets both from the tag
    expect(own.publishConfig).toEqual({ access: 'public', provenance: true });
    expect(fs.existsSync(path.join(CORNFIELD, 'components', 'package-lock.json'))).toBe(true);
    for (const [name, version] of Object.entries({ ...own.devDependencies, ...own.dependencies })) expect(version, name).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/); // exact, as the StencilRS starter pins them
    expect(own.devDependencies['@popcorn245/stencilrs']).toBeTruthy();
    expect(own.devDependencies['@stencil/core']).toBe('5.0.0-beta.25');
  });
});
