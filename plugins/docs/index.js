/**
 * @module plugins/docs
 *
 * The docs deriver: a repo's Markdown docs as one app on the map (`app-docs`) with a page per document,
 * and the links between them. A link from one doc to another is a usage link (dashed) between their pages;
 * a link to a file another deriver mapped (a module, a package, the root) is a usage link to that node, so
 * the map shows which docs describe which code. A link to a file or folder that is not in the repo is a
 * problem: `cornfield validate` fails on a broken link. A link to a heading that is not there is a warning.
 *
 * Options: `{ paths, app, label, parent }`: `paths` are the files and folders to read (default
 * `['README.md', 'docs']`; a folder is read for every `.md` under it), `app` the app's id (default
 * `app-docs`), `label` its label (default `docs`), `parent` the node it hangs from (default `root`, when an
 * earlier deriver made it). Run it after the derivers whose nodes the docs point at.
 *
 * The site (plugins/docs/site.js, `cornfield docs`) is built from what this deriver hands on as
 * `ctx.info.docs`: each page's file, route and title.
 */

import path from 'node:path';
import { markdownLinks, renderMarkdown } from './markdown.js';

export const DEFAULT_PATHS = ['README.md', 'docs'];

const isMarkdown = (f) => /\.md$/i.test(f);
const isReadme = (f) => /^readme\.md$/i.test(path.posix.basename(f));

/**
 * The Markdown files the paths name, sorted, each once.
 * @param {{ exists: Function, isDir: Function, walk: Function }} io
 * @param {string[]} paths
 */
export function docFiles(io, paths) {
  const out = new Set();
  for (const p of paths) {
    const rel = p.replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (io.isDir(rel)) io.walk(rel, isMarkdown).forEach((f) => out.add(f));
    else if (isMarkdown(rel) && io.exists(rel)) out.add(rel);
  }
  return [...out].sort();
}

/** The route of a doc: its path without `.md`, a README standing for its folder (`/`, `/docs/adr/`) */
export function docRoute(file) {
  if (isReadme(file)) {
    const dir = path.posix.dirname(file);
    return dir === '.' ? '/' : `/${dir}/`;
  }
  return `/${file.replace(/\.md$/i, '')}`;
}

/** Where a doc lands in the site: `docs/x.md` → `docs/x.html`, a README → its folder's `index.html` */
export function docOutput(file) {
  const route = docRoute(file);
  return route.endsWith('/') ? `${route.slice(1)}index.html` : `${route.slice(1)}.html`;
}

/** The page node id of a doc: `page-doc-` and its path, in kebab case */
export const docPageId = (file) => `page-doc-${file.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

/**
 * What a link in `from` points at, inside the repo: `{ path, hash }` (path '' for the doc itself), or
 * `{ external: true }` for a URL, or `{ outside: true }` for a path that leaves the repo.
 * @param {string} from the doc's path
 * @param {string} href the link as written
 */
export function resolveLink(from, href) {
  const raw = String(href || '').trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return { external: true };
  const hashAt = raw.indexOf('#');
  const hash = hashAt >= 0 ? raw.slice(hashAt + 1) : '';
  let rel = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).replace(/\?.*$/, '');
  if (!rel) return { path: '', hash };
  try { rel = decodeURI(rel); } catch { /* keep it as written */ }
  // A leading slash is the repo's root, as on the forge
  const joined = rel.startsWith('/') ? rel.slice(1) : path.posix.join(path.posix.dirname(from), rel);
  const norm = path.posix.normalize(joined).replace(/\/+$/, '');
  if (norm === '..' || norm.startsWith('../')) return { outside: true };
  return { path: norm === '.' ? '' : norm, hash, folder: rel.endsWith('/') };
}

export default {
  name: 'docs',
  contract: 1,
  derive(ctx) {
    const { paths = DEFAULT_PATHS, app: appId = 'app-docs', label = 'docs', parent = 'root' } = ctx.options || {};
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p)) throw new Error('options.paths is a list of files and folders, like ["README.md", "docs"].');
    const files = docFiles(ctx, paths);
    const empty = { nodes: [], edges: [], info: { pages: [] } };
    if (!files.length) return { ...empty, warnings: ctx.options?.paths ? [`docs: no Markdown in ${paths.join(', ')}.`] : [] };

    const warnings = [];
    const problems = [];
    const nodes = [{ id: appId, type: 'app', label, file: paths.map((p) => p.replace(/^\.\/+/, '').replace(/\/+$/, '')).find((p) => ctx.exists(p)) }];
    const edges = [];
    if (ctx.nodes.some((n) => n.id === parent)) edges.push({ from: parent, to: appId });

    const byFile = new Map();
    const pages = [];
    for (const file of files) {
      const id = docPageId(file);
      const clash = pages.find((p) => p.id === id);
      if (clash) { problems.push(`docs: ${file} and ${clash.file} would both be page "${id}"; rename one.`); continue; }
      const text = ctx.read(file);
      const { title, headings } = renderMarkdown(text);
      const page = { id, file, route: docRoute(file), output: docOutput(file), title: title || path.posix.basename(file, '.md'), anchors: headings.map((h) => h.id), text };
      pages.push(page);
      byFile.set(file, page);
      nodes.push({ id, type: 'page', label: page.route, file, summary: page.title });
      edges.push({ from: appId, to: id });
    }

    // The nodes earlier derivers made, by the file or folder they stand for (the first one made, when two share it)
    const byPath = new Map();
    for (const n of ctx.nodes) if (typeof n.file === 'string' && !byPath.has(n.file)) byPath.set(n.file, n.id);

    const seen = new Set();
    const link = (from, to) => {
      const key = `${from}|${to}`;
      if (from === to || seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, dashed: true });
    };
    for (const page of pages) {
      for (const { href } of markdownLinks(page.text)) {
        const t = resolveLink(page.file, href);
        if (t.external) continue;
        if (t.outside) { warnings.push(`docs: ${page.file} links to "${href}", outside the repo.`); continue; }
        const target = t.path === '' ? page.file : t.path;
        if (!ctx.exists(target)) { problems.push(`docs: ${page.file} links to "${href}", but ${target} is not in the repo.`); continue; }
        const readme = ctx.isDir(target) ? files.find((f) => path.posix.dirname(f) === target && isReadme(f)) : null;
        const doc = byFile.get(readme || target);
        if (doc) {
          if (t.hash && !doc.anchors.includes(t.hash)) warnings.push(`docs: ${page.file} links to "${href}", but ${doc.file} has no heading "#${t.hash}".`);
          link(page.id, doc.id);
        } else if (byPath.has(target)) link(page.id, byPath.get(target));
      }
    }

    return {
      nodes,
      edges,
      warnings,
      problems,
      ownedIds: [appId],
      pageOwners: [appId],
      info: { app: appId, pages: pages.map(({ text, ...p }) => p) },
    };
  },
};
