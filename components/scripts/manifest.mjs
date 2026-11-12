// The list of files a build produced: dist/manifest.json. The cornfield server serves the files of this list under /cornfield/components/ and
// nothing else (never a listing of the folder), so a stray file in dist/ is not served. Written last, by scripts/build.mjs.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const MANIFEST = 'manifest.json';
/** The only kinds of file a build may leave in dist/ (and so the only kinds the server serves) */
export const SERVED = /\.(?:js|css|json|d\.ts|map)$/;
/** A path the manifest may name: plain segments, none starting with a dot */
export const SAFE_PATH = /^(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Every file under `dist`, as posix paths relative to it, sorted; the manifest itself is not one */
export function distFiles(dist) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) { if (rel !== MANIFEST) out.push(rel); }
      else throw new Error(`dist/${rel} is neither a file nor a folder`);
    }
  };
  walk(dist, '');
  return out.sort();
}

/** Writes dist/manifest.json: `{ name, cornfield, files: [{ path, bytes, sha256 }] }`. Refuses a file the server could not serve safely. */
export function writeManifest(dist, { name, version }) {
  const files = distFiles(dist).map((path) => {
    if (!SAFE_PATH.test(path) || !SERVED.test(path)) throw new Error(`dist/${path} is not a file cornfield serves (.js .css .json .d.ts .map, plain names)`);
    const body = readFileSync(join(dist, path));
    return { path, bytes: statSync(join(dist, path)).size, sha256: createHash('sha256').update(body).digest('hex') };
  });
  writeFileSync(join(dist, MANIFEST), `${JSON.stringify({ name, cornfield: version, files }, null, 2)}\n`);
  return files;
}
