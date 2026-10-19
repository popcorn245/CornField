/**
 * @module plugins/docs/site
 *
 * The docs as a small static site, built from what the docs deriver (plugins/docs) mapped: a page per
 * document at its route, a sidebar of every page, and on each page the map around it (what it links to,
 * what links to it, the code it describes). `map.html` draws the whole map of the docs' links. A link
 * between docs goes to the other page; an image is copied beside its page; a link to any other file of
 * the repo goes to the file on the forge (`sourceUrl`), or is left as text when there is none.
 *
 * `buildSite` runs the repo's derivers (the docs deriver with its defaults when the config names none),
 * so the site is the map's view of the docs. `cornfield docs [--out _site]` calls it. No dependencies:
 * plain HTML and one stylesheet, every link relative, so it serves from any folder (GitHub Pages too).
 */

import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml as esc } from '../../core/text.js';
import { deriveTopology } from '../../core/derive.js';
import { readTopology } from '../../core/validate.js';
import { renderMarkdown } from './markdown.js';
import docsDeriver, { resolveLink } from './index.js';

/** The file a built site holds, so a rebuild knows the folder is its own */
export const SITE_MARKER = '.cornfield-site';
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

/** The forge URL a repo file is shown at, from the config's forge, or null */
export function sourceUrlOf(config) {
  const f = config?.forge;
  if (!f || !f.repo) return null;
  const origin = String(f.url || (f.type === 'github' ? 'https://github.com' : '')).replace(/\/+$/, '');
  if (!origin) return null;
  return f.type === 'forgejo' ? `${origin}/${f.repo}/src/branch/main` : `${origin}/${f.repo}/blob/HEAD`;
}

/** A link from one site file to another, relative */
const relHref = (fromOutput, toOutput) => {
  const rel = path.posix.relative(path.posix.dirname(fromOutput), toOutput);
  return rel || path.posix.basename(toOutput);
};

/**
 * The site's files, as `{ path: content }` (text, or `{ copy: repoPath }` for a file copied as it is). Pure
 * apart from `read`.
 * @param {{ title: string, pages: object[], nodes: object[], edges: object[], read: (rel: string) => string,
 *   exists: (rel: string) => boolean, isDir: (rel: string) => boolean, sourceUrl?: string | null }} opts
 *   `pages` as the docs deriver hands them on (`info.docs.pages`), `nodes` and `edges` the derived map
 * @returns {Record<string, string | { copy: string }>}
 */
export function siteFiles({ title, pages, nodes, edges, read, exists, isDir, sourceUrl = null }) {
  const files = {};
  const byId = new Map(pages.map((p) => [p.id, p]));
  const byFile = new Map(pages.map((p) => [p.file, p]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(pages.map((p) => [p.id, []]));
  const back = new Map(pages.map((p) => [p.id, []]));
  for (const e of edges) {
    if (!e.dashed || !byId.has(e.from)) continue;
    out.get(e.from).push(e.to);
    if (byId.has(e.to)) back.get(e.to).push(e.from);
  }
  const fileHref = (from, rel, hash = '') => (sourceUrl ? `${sourceUrl}/${rel.split('/').map(encodeURIComponent).join('/')}${hash ? `#${hash}` : ''}` : null);
  const nav = (current) => {
    const groups = Object.groupBy(pages, (p) => (path.posix.dirname(p.file) === '.' ? '' : path.posix.dirname(p.file)));
    const readmeFirst = (list) => [...list].sort((a, b) => Number(b.route.endsWith('/')) - Number(a.route.endsWith('/')));
    return Object.keys(groups).sort().map((dir) => `<section><h2>${esc(dir || title)}</h2><ul>${readmeFirst(groups[dir]).map((p) => `<li><a href="${esc(relHref(current.output, p.output))}"${p === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul></section>`).join('');
  };
  const layout = (output, heading, body, current = null) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading === title ? title : `${heading} · ${title}`)}</title>
<link rel="stylesheet" href="${esc(relHref(output, 'site.css'))}">
</head>
<body>
<header class="top"><a class="brand" href="${esc(relHref(output, 'index.html'))}">${esc(title)}</a><nav><a href="${esc(relHref(output, 'map.html'))}"${output === 'map.html' ? ' aria-current="page"' : ''}>Map of the docs</a>${sourceUrl ? `<a href="${esc(sourceUrl.replace(/\/(blob|src)\/.*$/, ''))}">Source</a>` : ''}</nav></header>
<div class="wrap">
<aside class="side"><details open><summary>Pages</summary>${nav(current || { output })}</details></aside>
<main>
${body}
</main>
</div>
<footer>Built by cornfield from the docs' own map: each page is a node, each link an edge. <a href="${esc(relHref(output, 'map.html'))}">See the map</a>.</footer>
</body>
</html>
`;

  for (const page of pages) {
    const { html } = renderMarkdown(read(page.file), {
      link: (href, { image }) => {
        const t = resolveLink(page.file, href);
        if (t.external) return href;
        if (t.outside) return null;
        if (t.path === '') return t.hash ? `#${t.hash}` : relHref(page.output, page.output);
        const readme = isDir(t.path) ? pages.find((p) => path.posix.dirname(p.file) === t.path && /^readme\.md$/i.test(path.posix.basename(p.file))) : null;
        const doc = readme || byFile.get(t.path);
        if (doc) return `${relHref(page.output, doc.output)}${t.hash ? `#${t.hash}` : ''}`;
        if (!exists(t.path)) return null;
        if (image && IMAGE.test(t.path) && !isDir(t.path)) {
          files[t.path] = { copy: t.path };
          return relHref(page.output, t.path);
        }
        return fileHref(page.file, t.path, t.hash);
      },
    });
    const item = (id) => {
      const doc = byId.get(id);
      if (doc) return `<li><a href="${esc(relHref(page.output, doc.output))}">${esc(doc.title)}</a></li>`;
      const n = nodeById.get(id);
      if (!n) return '';
      const href = n.file ? fileHref(page.file, n.file) : null;
      return `<li>${href ? `<a href="${esc(href)}"><code>${esc(n.file)}</code></a>` : `<code>${esc(n.file || n.label)}</code>`} <span class="type">${esc(n.type)}</span></li>`;
    };
    const docsOut = out.get(page.id).filter((id) => byId.has(id));
    const codeOut = out.get(page.id).filter((id) => !byId.has(id));
    const links = [
      ['Links to', docsOut], ['Linked from', back.get(page.id)], ['The code it describes', codeOut],
    ].filter(([, ids]) => ids.length).map(([h, ids]) => `<section><h2>${h}</h2><ul>${ids.map(item).join('')}</ul></section>`).join('');
    const edit = fileHref(page.file, page.file);
    const body = `<article class="doc">
${html}
</article>
<aside class="links" aria-label="This page on the map">
<p class="where"><code>${esc(page.route)}</code> · <code>${esc(page.id)}</code>${edit ? ` · <a href="${esc(edit)}">${esc(page.file)}</a>` : ''}</p>
${links || '<p>No links to or from the other docs yet.</p>'}
</aside>`;
    files[page.output] = layout(page.output, page.title, body, page);
  }

  files['map.html'] = layout('map.html', 'Map of the docs', mapBody({ pages, nodes: nodeById, out, back }));
  files['site.css'] = SITE_CSS;
  return files;
}

/** The map page: every doc around a circle, the code the docs point at inside it, and a line per link */
function mapBody({ pages, nodes, out, back }) {
  const docIds = pages.map((p) => p.id);
  const codeIds = [...new Set(pages.flatMap((p) => out.get(p.id)).filter((id) => !docIds.includes(id) && nodes.has(id)))].sort();
  const size = 760;
  const c = size / 2;
  const place = (ids, r) => new Map(ids.map((id, i) => {
    const a = (2 * Math.PI * i) / Math.max(ids.length, 1) - Math.PI / 2;
    return [id, { x: c + r * Math.cos(a), y: c + r * Math.sin(a), a }];
  }));
  const at = new Map([...place(docIds, 250), ...place(codeIds, 120)]);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const f = (n) => n.toFixed(1);
  const lines = pages.flatMap((p) => out.get(p.id).filter((to) => at.has(to)).map((to) => {
    const a = at.get(p.id);
    const b = at.get(to);
    const code = !byId.has(to);
    return `<path class="edge${code ? ' code' : ''}" d="M${f(a.x)},${f(a.y)} Q${f((a.x + b.x) / 2 * 0.6 + c * 0.4)},${f((a.y + b.y) / 2 * 0.6 + c * 0.4)} ${f(b.x)},${f(b.y)}"><title>${esc(p.title)} → ${esc(byId.get(to)?.title || nodes.get(to).file || to)}</title></path>`;
  }));
  const label = (id, text, href, cls) => {
    const { x, y, a } = at.get(id);
    const right = Math.cos(a) >= 0;
    const tx = x + (right ? 10 : -10);
    const deg = (a * 180) / Math.PI + (right ? 0 : 180);
    const short = text.length > 34 ? `${text.slice(0, 33)}…` : text;
    const dot = `<circle class="dot ${cls}" cx="${f(x)}" cy="${f(y)}" r="${cls === 'doc' ? 5 : 4}"/>`;
    const words = `<text class="${cls}" x="${f(tx)}" y="${f(y)}" text-anchor="${right ? 'start' : 'end'}" dominant-baseline="middle" transform="rotate(${f(deg)} ${f(x)} ${f(y)})">${esc(short)}</text>`;
    return href ? `<a href="${esc(href)}"><title>${esc(text)}</title>${dot}${words}</a>` : `<g><title>${esc(text)}</title>${dot}${words}</g>`;
  };
  const docLabels = pages.map((p) => label(p.id, p.title, p.output, 'doc'));
  const codeLabels = codeIds.map((id) => label(id, nodes.get(id).file || nodes.get(id).label, null, 'code'));
  const pad = 230;
  const svg = `<svg class="map" viewBox="${-pad} ${-pad / 2} ${size + 2 * pad} ${size + pad}" role="img" aria-label="The docs and their links">
<g class="edges">${lines.join('')}</g>
${docLabels.join('\n')}
${codeLabels.join('\n')}
</svg>`;
  const rows = pages.map((p) => {
    const to = out.get(p.id).map((id) => byId.get(id)?.title || nodes.get(id)?.file).filter(Boolean);
    const from = back.get(p.id).map((id) => byId.get(id).title);
    return `<tr><td><a href="${esc(p.output)}">${esc(p.title)}</a><br><code>${esc(p.file)}</code></td><td>${to.length ? esc(to.join(', ')) : '—'}</td><td>${from.length ? esc(from.join(', ')) : '—'}</td></tr>`;
  });
  const edgeCount = pages.reduce((s, p) => s + out.get(p.id).length, 0);
  return `<article class="doc wide">
<h1>Map of the docs</h1>
<p>${pages.length} pages and ${edgeCount} links, as the docs deriver puts them on the map: each document is a page node, each link between two documents (or from a document to the code it describes) a usage link. Docs sit on the outer ring, the code they point at inside it. Select a document to open it.</p>
<div class="map-frame">${svg}</div>
<h2>Every page</h2>
<div class="table"><table>
<thead><tr><th>Page</th><th>Links to</th><th>Linked from</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table></div>
</article>`;
}

/**
 * Builds the site into `out`: runs the derivers, writes every page, copies the images.
 * @param {{ config: object, derivers: { deriver: object, options?: object }[], out: string, sourceUrl?: string | null }} opts
 *   a loaded config and its derivers (core/config.js); `out` an absolute folder, emptied first
 * @returns {Promise<{ pages: number, files: string[], warnings: string[], problems: string[] }>}
 */
export async function buildSite({ config, derivers, out, sourceUrl = sourceUrlOf(config) }) {
  const root = config.root;
  if (path.resolve(out) === path.resolve(root) || path.relative(out, root).split(path.sep)[0] !== '..') throw new Error(`The site's folder (${out}) must not hold the repo.`);
  const list = derivers.some((d) => d.deriver.name === docsDeriver.name) ? derivers : [...derivers, { deriver: docsDeriver, options: {} }];
  const derived = await deriveTopology({ root, config, derivers: list, map: readTopology(config) });
  const pages = derived.info.docs?.pages || [];
  if (!pages.length) throw new Error('There are no docs to build: the docs deriver found no Markdown (see its "paths" option).');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(root, rel));
  const isDir = (rel) => { try { return fs.statSync(path.join(root, rel)).isDirectory(); } catch { return false; } };
  const files = siteFiles({ title: config.title || 'Docs', pages, nodes: derived.nodes, edges: derived.edges, read, exists, isDir, sourceUrl });
  // Only a folder this builds (it leaves a marker) or an empty one is emptied: never a folder of the repo's own files
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, SITE_MARKER))) throw new Error(`${out} is not empty and is not a site cornfield built: pick another folder, or empty it first.`);
  fs.rmSync(out, { recursive: true, force: true });
  files[SITE_MARKER] = 'Built by cornfield docs. This folder is emptied on every build.\n';
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(out, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (typeof content === 'string') fs.writeFileSync(dest, content, 'utf8');
    else fs.copyFileSync(path.join(root, content.copy), dest);
  }
  return { pages: pages.length, files: Object.keys(files).sort(), warnings: derived.warnings, problems: derived.problems };
}

const SITE_CSS = `:root {
  --bg: #fbfaf7; --panel: #f3f1ea; --text: #1f2328; --muted: #5b616b; --line: #dedbd2;
  --accent: #b45309; --link: #1d4ed8; --code-bg: #efece4; --doc: #0284c7; --code: #0d9488;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14161a; --panel: #1b1e23; --text: #e6e6e3; --muted: #a0a4ab; --line: #2c3037;
    --accent: #f59e0b; --link: #7cb4ff; --code-bg: #22262c; --doc: #38bdf8; --code: #2dd4bf;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #14161a; --panel: #1b1e23; --text: #e6e6e3; --muted: #a0a4ab; --line: #2c3037;
  --accent: #f59e0b; --link: #7cb4ff; --code-bg: #22262c; --doc: #38bdf8; --code: #2dd4bf;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
code { background: var(--code-bg); padding: 0.1em 0.35em; border-radius: 4px; overflow-wrap: anywhere; }
pre { background: var(--code-bg); padding: 12px 14px; border-radius: 8px; overflow-x: auto; line-height: 1.45; }
pre code { background: none; padding: 0; overflow-wrap: normal; }
img { max-width: 100%; height: auto; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 1; }
.brand { font-weight: 700; color: var(--accent); text-decoration: none; font-size: 1.1rem; }
.top nav { display: flex; gap: 16px; font-size: 0.95rem; }
.top nav a { text-decoration: none; }
.top nav a[aria-current] { font-weight: 600; text-decoration: underline; }
.wrap { display: grid; grid-template-columns: 1fr; gap: 0 32px; max-width: 1200px; margin: 0 auto; padding: 0 16px; }
@media (min-width: 900px) { .wrap { grid-template-columns: 240px minmax(0, 1fr); } }
.side { font-size: 0.92rem; padding-top: 16px; order: 2; border-top: 1px solid var(--line); }
@media (min-width: 900px) { .side { order: 0; border-top: 0; } }
.side summary { cursor: pointer; font-weight: 600; margin-bottom: 4px; }
.side h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 14px 0 4px; }
.side ul { list-style: none; margin: 0; padding: 0; }
.side li a { display: block; overflow-wrap: anywhere; padding: 3px 6px; border-radius: 4px; text-decoration: none; color: var(--text); }
.side li a:hover { background: var(--code-bg); }
.side li a[aria-current] { background: var(--code-bg); color: var(--accent); font-weight: 600; }
@media (min-width: 900px) { .side { position: sticky; top: 56px; align-self: start; max-height: calc(100vh - 56px); overflow-y: auto; } }
main { min-width: 0; padding-bottom: 32px; }
.doc { max-width: 760px; }
.doc.wide { max-width: none; }
.doc h1 { font-size: 2rem; line-height: 1.2; margin: 24px 0 12px; }
.doc h2 { margin-top: 32px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
.doc :is(h1, h2, h3, h4) { position: relative; }
.anchor { position: absolute; left: -1em; width: 1em; opacity: 0; text-decoration: none; color: var(--muted); }
:is(h1, h2, h3, h4):hover .anchor { opacity: 1; }
blockquote { margin: 16px 0; padding: 4px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
.table { overflow-x: auto; }
table { border-collapse: collapse; margin: 16px 0; font-size: 0.95rem; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--panel); }
hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
.links { max-width: 760px; margin-top: 40px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font-size: 0.92rem; }
.links h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 12px 0 4px; }
.links ul { margin: 0; padding-left: 18px; }
.links .where { margin: 0; color: var(--muted); }
.type { color: var(--muted); font-size: 0.85em; }
.map-frame { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.map { display: block; width: 100%; height: auto; max-height: 85vh; }
.map .edge { fill: none; stroke: var(--doc); stroke-opacity: 0.35; stroke-width: 1.2; stroke-dasharray: 4 3; }
.map .edge.code { stroke: var(--code); }
.map .dot.doc { fill: var(--doc); }
.map .dot.code { fill: var(--code); }
.map text { font-size: 12px; fill: var(--text); }
.map text.code { fill: var(--muted); font-family: ui-monospace, monospace; font-size: 11px; }
.map a:hover text { fill: var(--accent); font-weight: 600; }
footer { border-top: 1px solid var(--line); padding: 16px; color: var(--muted); font-size: 0.85rem; text-align: center; }
`;
