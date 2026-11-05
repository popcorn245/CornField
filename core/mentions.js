/**
 * @module core/mentions
 *
 * How a thread points at the map (spec 0005, D7). Pure: no I/O, no DOM, no Node built-ins, so the server (a hook's
 * payload) and the explorer (the lights, a node's "Mentioned in") load the same file.
 *
 *   - **Mentions.** People write `[[core-server-auth]]` (a node's id) or `[[server/auth.js]]` (a repo path) in prose.
 *     `parseMentions` reads them outside code: a fenced block and an inline code span are text about code, not links.
 *   - **A block.** Tools and agents may write a fenced block for precise links:
 *
 *         ```cornfield-thread
 *         { "nodes": ["core-server-auth", "server/hooks.js"], "proposal": "0013-meals" }
 *         ```
 *
 *     `nodes` are read like mentions (an id or a path); `proposal` is a proposal's slug. A block that is not that shape
 *     is ignored, and prose is read as before.
 *   - **Resolving.** `resolveMention` answers a reference in this order: a node's id; a node whose `file` is exactly
 *     that path; the node(s) that own the path (the deepest `file` that is the path or a folder above it, as a file
 *     lights its node for a pull request, `nodesForFile`). A reference that is none of these resolves to nothing and
 *     stays plain text, which reads sensibly on the forge without cornfield.
 *   - **Caps.** At most `MAX_MENTIONS` distinct references are read from one text, and a reference is at most
 *     `MAX_REF` characters, so a comment cannot make the map light up everything or cost a lot to read.
 *   - **Links.** `threadOfPull` reads the thread a spec PR names: `Thread: #n` or `Closes #n` (also Fixes and Resolves).
 */

/** The most distinct references read from one text, and the longest one */
export const MAX_MENTIONS = 50;
export const MAX_REF = 200;
/** The most a `cornfield-thread` block may name */
export const MAX_BLOCK_NODES = 50;
/** The fence's info string that marks a block of links */
export const THREAD_BLOCK = 'cornfield-thread';

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

const clean = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * The node(s) whose `file` holds a path: the node's `file` is the path itself or a folder above it, and the deepest
 * (longest) `file` wins. A file that holds several nodes (a page and what renders it) lights all of them. (The explorer's
 * forge panel lights a pull request's files with this same rule.)
 * @param {string} path a repo-relative path
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {object[]} the nodes, [] when none holds it
 */
export function nodesForFile(path, nodes) {
  const p = clean(path);
  let best = -1;
  let out = [];
  for (const node of nodes) {
    if (typeof node.file !== 'string' || node.file === '') continue;
    const file = clean(node.file);
    if (p !== file && !p.startsWith(`${file}/`)) continue;
    if (file.length > best) { best = file.length; out = [node]; } else if (file.length === best) out.push(node);
  }
  return out;
}

/**
 * Splits text into prose and code: `prose` is the text with every fenced block and inline code span blanked (same length,
 * so offsets hold), `fences` are the fenced blocks as `{ info, body }`.
 * @param {string} text
 * @returns {{ prose: string, fences: { info: string, body: string }[] }}
 */
export function scan(text) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const fences = [];
  const out = [];
  let open = null; // { char, len, info, body: [] }
  for (const line of lines) {
    if (open) {
      const close = new RegExp(`^ {0,3}${open.char}{${open.len},}[ \\t]*\\r?$`).test(line);
      if (close) { fences.push({ info: open.info, body: open.body.join('\n') }); open = null; } else open.body.push(line.replace(/\r$/, ''));
      out.push(' '.repeat(line.length));
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\r]*)$/.exec(line);
    // An info string of a backtick fence cannot hold a backtick (then it is an inline span, not a fence)
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = { char: m[1][0], len: m[1].length, info: m[2].trim(), body: [] };
      out.push(' '.repeat(line.length));
      continue;
    }
    out.push(line);
  }
  // A fence left open runs to the end of the text, as the forge's Markdown reads it
  if (open) fences.push({ info: open.info, body: open.body.join('\n') });
  return { prose: blankSpans(out.join('\n')), fences };
}

/** Inline code spans blanked: a run of backticks closes at the next run of the same length */
function blankSpans(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') { out += text[i++]; continue; }
    let n = 0;
    while (text[i + n] === '`') n++;
    let j = i + n;
    let end = -1;
    while (j < text.length) {
      if (text[j] !== '`') { j++; continue; }
      let m = 0;
      while (text[j + m] === '`') m++;
      if (m === n) { end = j + m; break; }
      j += m;
    }
    if (end === -1) { out += text.slice(i, i + n); i += n; continue; }
    out += text.slice(i, end).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

/** A reference as written, made comparable: no `./`, no trailing slash, no `#L10` or `:10` line suffix; or null when it is not one */
export function normalizeRef(raw) {
  let ref = String(raw ?? '').trim();
  if (ref === '' || ref.length > MAX_REF || /[\0\n\r]/.test(ref)) return null;
  ref = ref.replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '');
  ref = clean(ref).trim();
  if (ref === '' || ref.startsWith('/') || ref.split('/').some((p) => p === '..' || p === '.')) return null;
  return ref;
}

/**
 * The `cornfield-thread` block of a text, or null: the first well-formed one wins.
 * @param {{ info: string, body: string }[]} fences
 * @returns {{ nodes: string[], proposal: string | null } | null}
 */
function blockOf(fences) {
  for (const f of fences) {
    if (f.info.split(/\s+/)[0] !== THREAD_BLOCK) continue;
    let json;
    try { json = JSON.parse(f.body); } catch { continue; }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) continue;
    const nodes = Array.isArray(json.nodes) ? json.nodes.map((n) => (typeof n === 'string' ? normalizeRef(n) : null)).filter((r) => r !== null).slice(0, MAX_BLOCK_NODES) : [];
    const proposal = typeof json.proposal === 'string' && SLUG.test(json.proposal) ? json.proposal : null;
    if (!nodes.length && !proposal) continue;
    return { nodes: [...new Set(nodes)], proposal };
  }
  return null;
}

/**
 * What a text points at, before the map is asked: the `[[…]]` references outside code (each once, in order, at most
 * `MAX_MENTIONS`), and the `cornfield-thread` block when there is one.
 * @param {string} text
 * @returns {{ refs: string[], block: { nodes: string[], proposal: string | null } | null, truncated: boolean }}
 */
export function parseMentions(text) {
  const { prose, fences } = scan(text);
  const refs = [];
  let truncated = false;
  for (const m of prose.matchAll(/(?<!\\)\[\[([^[\]\n]{1,400})\]\]/g)) {
    const ref = normalizeRef(m[1]);
    if (ref === null || refs.includes(ref)) continue;
    if (refs.length >= MAX_MENTIONS) { truncated = true; break; }
    refs.push(ref);
  }
  return { refs, block: blockOf(fences), truncated };
}

/**
 * The nodes one reference stands for, in order of how sure it is: the id; else nodes whose `file` is exactly the path;
 * else the nodes that own the path.
 * @param {string} ref
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {object[]}
 */
export function resolveMention(ref, nodes) {
  const r = normalizeRef(ref);
  if (r === null) return [];
  const byId = nodes.filter((n) => n.id === r);
  if (byId.length) return byId;
  const exact = nodes.filter((n) => typeof n.file === 'string' && n.file !== '' && clean(n.file) === r);
  if (exact.length) return exact;
  return nodesForFile(r, nodes);
}

/**
 * References resolved against a map.
 * @param {string[]} refs references as `parseMentions` gives them (or a block's `nodes`)
 * @param {{ id: string, file?: string }[]} nodes
 * @returns {{ resolved: { ref: string, ids: string[] }[], ids: string[], unresolved: string[] }} `ids`: every node once, in
 *   order; `unresolved`: the references that are on no node (they stay text)
 */
export function resolveMentions(refs, nodes) {
  const resolved = [];
  const unresolved = [];
  const seen = new Set();
  const list = Array.isArray(refs) ? refs.slice(0, MAX_MENTIONS + MAX_BLOCK_NODES) : [];
  for (const ref of list) {
    const found = resolveMention(ref, nodes);
    if (!found.length) { unresolved.push(ref); continue; }
    const ids = found.map((n) => n.id);
    resolved.push({ ref, ids });
    for (const id of ids) seen.add(id);
  }
  return { resolved, ids: [...seen], unresolved };
}

/**
 * Everything a set of texts (a thread's messages) points at, before the map is asked: the references of every text and of
 * its blocks, each once, and the proposal a block names (the first).
 * @param {string[]} texts
 * @returns {{ refs: string[], proposal: string | null, truncated: boolean }}
 */
export function linksOf(texts) {
  const refs = [];
  let proposal = null;
  let truncated = false;
  const cap = MAX_MENTIONS * 2;
  for (const text of texts) {
    const got = parseMentions(text);
    truncated ||= got.truncated;
    for (const ref of [...got.refs, ...(got.block ? got.block.nodes : [])]) {
      if (refs.includes(ref)) continue;
      if (refs.length >= cap) { truncated = true; break; }
      refs.push(ref);
    }
    if (proposal === null && got.block && got.block.proposal) proposal = got.block.proposal;
  }
  return { refs, proposal, truncated };
}

/**
 * The thread a spec PR's text names: `Thread: #n`, or `Closes #n` (also Fixes and Resolves, and their other tenses), outside
 * code. The first one named. An issue in another repo (`owner/name#n`) is not this repo's thread.
 * @param {string} body
 * @returns {number | null}
 */
export function threadOfPull(body) {
  const { prose } = scan(body);
  // `(?:\s*:)?\s+` and not `\s*:?\s+`: two whitespace runs side by side backtrack against each other, which made a long
  // run of spaces after "Closes" (or a code block, blanked to spaces) quadratic; this way each run is read once
  const m = /(?:^|[\s(])(?:thread\s*:|(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:)?)\s+#([1-9]\d{0,8})\b/i.exec(prose);
  return m ? Number(m[1]) : null;
}
