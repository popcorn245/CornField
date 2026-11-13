// The size budget (spec 0011 D11): the gzipped size of the runtime chunk, of corn-map with its engine, of corn-map with what a `src` brings, of corn-review
// alone and with what a `src` brings, of corn-scope with what it loads, and of each piece around the map alone and added to a page that has the map (what each entry pulls in besides the runtime), against size-budget.json. A build more than 5% over a budget fails; `--record` writes what the build measures as the new budget.
//   node scripts/size-budget.mjs [--record]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PACKAGE } from './shared.mjs';

const TOLERANCE = 0.05;
/** The pieces around the map: `<corn-node-panel>`, `<corn-layers>`, `<corn-search>` */
const AROUND = ['corn-node-panel', 'corn-layers', 'corn-search'];
const dist = join(PACKAGE, 'dist');
const budgetFile = join(PACKAGE, 'size-budget.json');
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;

/**
 * The files an entry loads, found through the static imports of each (and, with `dynamic`, its `import("./…")`s too: what a `<corn-map src>` fetches
 * once it has a src): `chunks/runtime-…` is the runtime, the rest is the entry's own
 */
function reach(entry, dynamic = false, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = readFileSync(join(dist, entry), 'utf8');
  const pattern = dynamic ? /(?:from|import)\s*\(?\s*["']\.\/?((?:chunks\/)?[\w.-]+\.js)["']/g : /(?:from|import)\s*["']\.\/?((?:chunks\/)?[\w.-]+\.js)["']/g;
  for (const m of text.matchAll(pattern)) reach(m[1].startsWith('chunks/') || m[1].includes('/') ? m[1] : (entry.startsWith('chunks/') ? `chunks/${m[1]}` : m[1]), dynamic, seen);
  return seen;
}

/** What the build measures now, in bytes of gzip (level 9) */
export function measure() {
  const runtime = readdirSync(join(dist, 'chunks')).find((f) => f.startsWith('runtime-'));
  if (!runtime) throw new Error('no runtime chunk in dist/chunks');
  const notRuntime = (f) => !f.startsWith('chunks/runtime-');
  const withMap = reach('corn-map.js');
  const added = (entry) => [...reach(entry)].filter((f) => notRuntime(f) && !withMap.has(f)).reduce((sum, f) => sum + gz(f), 0);
  const own = (entry, dynamic = false) => [...reach(entry, dynamic)].filter((f) => !f.startsWith('chunks/runtime-')).reduce((sum, f) => sum + gz(f), 0);
  // Each is what the entry loads besides the runtime; they share the engine's chunk, so they do not add up. `corn-map` is a map handed its data;
  // `corn-map-src` the same with the chunk a `src` (or a scope) brings: the loading, the states, the server's theme
  // `corn-review` is a review handed its data and `corn-review-src` the same with the chunk a `src` brings (the load, the card, the server's theme); the review
  // shares the engine's chunks with the map, so a map alone loads what the review uses of the modules they share (the growth of `corn-map` when it arrived)
  return {
    runtime: gz(`chunks/${runtime}`),
    'corn-map': own('corn-map.js'), 'corn-map-src': own('corn-map.js', true),
    'corn-review': own('corn-review.js'), 'corn-review-src': own('corn-review.js', true),
    'corn-scope': own('corn-scope.js'),
    // The pieces around the map: each alone, and what each adds to a page that already has `corn-map` (what it loads that the map did not)
    ...Object.fromEntries(AROUND.flatMap((tag) => [[tag, own(`${tag}.js`)], [`${tag}-added`, added(`${tag}.js`)]])),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = measure();
  if (process.argv.includes('--record')) {
    writeFileSync(budgetFile, `${JSON.stringify({ unit: 'bytes, gzip level 9', tolerance: TOLERANCE, budget: now }, null, 2)}\n`);
    console.log('recorded', now);
  } else {
    const { budget, tolerance = TOLERANCE } = JSON.parse(readFileSync(budgetFile, 'utf8'));
    let failed = tolerance > TOLERANCE; // the file cannot loosen the check
    if (failed) console.log(`tolerance ${tolerance} is over ${TOLERANCE}`);
    // Every measure has a budget, and every budget a measure: an entry added or renamed without one is not left unchecked
    for (const name of Object.keys(now)) if (!(name in budget)) { console.log(`${name}: ${now[name]} B gzip, and no budget  OVER`); failed = true; }
    for (const [name, limit] of Object.entries(budget)) {
      const size = now[name];
      const over = !(size <= limit * (1 + tolerance));
      console.log(`${name}: ${size} B gzip (budget ${limit}, limit ${Math.floor(limit * (1 + tolerance))})${over ? '  OVER' : ''}`);
      if (over) failed = true;
    }
    if (failed) { console.error('The build is more than 5% over its size budget. If the growth is on purpose, run `npm run size:record` and say why in the commit.'); process.exit(1); }
  }
}
