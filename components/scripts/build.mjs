// The package build: the ES modules (Vite, StencilRS), then tokens.css, the type declarations and the file that says which cornfield they are.
//   node scripts/build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { PACKAGE, tokensCss, version } from './shared.mjs';
import { writeTypes } from './types.mjs';

await build({ configFile: join(PACKAGE, 'vite.lib.config.ts'), logLevel: 'warn' });
const dist = join(PACKAGE, 'dist');
writeFileSync(join(dist, 'tokens.css'), tokensCss());
const types = writeTypes(join(dist, 'types'));
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'version.json'), `${JSON.stringify({ name: '@popcorn245/cornfield-components', cornfield: version })}\n`);
console.log(`built cornfield-components ${version}: dist/ (${types.length} declaration files, tokens.css, version.json)`);
