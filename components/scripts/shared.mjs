// What every Vite configuration of this package shares: where the engine is, the version, the generated default tokens.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultTokensCss } from './tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE = resolve(here, '..');
export const REPO = resolve(PACKAGE, '..');

/** cornfield's version: the root package.json, which is what the server reports as `version` (the release sets it there from the tag) */
export const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

/** The tags of the components: every `tag: 'corn-…'` of src/components/<name>/<name>.tsx */
export function componentTags() {
  const dir = join(PACKAGE, 'src', 'components');
  return readdirSync(dir).map((name) => {
    const text = readFileSync(join(dir, name, `${name}.tsx`), 'utf8');
    const m = /tag:\s*'([a-z][a-z0-9-]*)'/.exec(text);
    if (!m) throw new Error(`${name}.tsx names no tag`);
    return m[1];
  }).sort();
}

/** The generated default tokens, as text */
export const tokensCss = () => defaultTokensCss(readFileSync(join(REPO, 'explorer', 'tokens.css'), 'utf8'), { tags: componentTags() });

export const define = { __CORNFIELD_VERSION__: JSON.stringify(version) };

/** A Vite plugin: `import css from '…/default-tokens.css?inline'` is the generated sheet (one source, no copy on disk) */
export function cornTokens() {
  const id = '\0corn-default-tokens';
  return {
    name: 'corn-default-tokens',
    enforce: 'pre',
    resolveId(source) { return /generated\/default-tokens\.css\?inline$/.test(source) ? id : null; },
    load(requested) {
      if (requested !== id) return null;
      this.addWatchFile(join(REPO, 'explorer', 'tokens.css'));
      return `export default ${JSON.stringify(tokensCss())};`;
    },
  };
}

/** Dev server and tests read the engine from ../explorer and ../core */
export const server = { fs: { allow: [REPO] } };

/** A Vite plugin: `/demo/topology.json` is the synthetic fixture's map and `/demo/proposal.json` one of its rich proposals (test/fixtures/big, generated in memory: nothing generated is committed) */
export function demoTopology() {
  let body = null;
  let proposal = null;
  return {
    name: 'corn-demo-topology',
    async configureServer(devServer) {
      const made = async () => {
        if (body) return;
        const { buildTopology } = await import(pathToFileURL(join(REPO, 'test', 'fixtures', 'big', 'make.js')).href);
        const { makeProposals } = await import(pathToFileURL(join(REPO, 'test', 'fixtures', 'big', 'proposals.js')).href);
        const topology = buildTopology();
        body = JSON.stringify({ nodes: topology.nodes, edges: topology.edges });
        const files = makeProposals(topology);
        proposal = files[Object.keys(files).sort().find((f) => f.startsWith('0100-'))];
      };
      devServer.middlewares.use('/demo/topology.json', async (_req, res) => {
        await made();
        res.setHeader('content-type', 'application/json');
        res.end(body);
      });
      devServer.middlewares.use('/demo/proposal.json', async (_req, res) => {
        await made();
        res.setHeader('content-type', 'application/json');
        res.end(proposal);
      });
    },
  };
}
