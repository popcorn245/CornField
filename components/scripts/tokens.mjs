// The default tokens as a package ships them: explorer/tokens.css (the one source of every --corn-* value) with every selector at zero
// specificity, plus what a `theme` attribute on a corn-* element needs (spec 0011 D7). Nothing is copied by hand: change a value in
// explorer/tokens.css and the next build carries it.
//
//   defaultTokensCss(source, { tags })  ->  the stylesheet text
//
// Zero specificity: every selector is wrapped in :where(), so any ordinary rule of the host's, on :root or on one element, overrides it
// whatever its own specificity. `theme="light"` or `theme="dark"` on an element declares that mode's tokens on the element itself.

/** The text between the braces that open at `from` (index of '{'), and the index after the closing brace */
function block(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return [text.slice(from + 1, i), i + 1];
  }
  throw new Error('tokens.css: a brace is never closed');
}

/** Top-level rules of a stylesheet (comments removed): `{ prelude, body }`; an at-rule's body is parsed again by the caller */
export function parseRules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    if (open < 0) break;
    const prelude = text.slice(at, open).trim();
    const [body, next] = block(text, open);
    rules.push({ prelude, body: body.trim() });
    at = next;
  }
  return rules;
}

/** The selectors of a prelude, split on top-level commas */
function selectorsOf(prelude) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && !depth) { out.push(prelude.slice(start, i).trim()); start = i + 1; }
  }
  out.push(prelude.slice(start).trim());
  return out.filter(Boolean);
}

const zero = (prelude) => selectorsOf(prelude).map((s) => `:where(${s})`).join(',\n');

/** The declarations of a rule body as `[name, value]` pairs (custom properties and ordinary ones alike) */
export function declarationsOf(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if ((c === ';' && !depth) || i === body.length) {
      const piece = body.slice(start, i).trim();
      start = i + 1;
      const colon = piece.indexOf(':');
      if (colon > 0) out.push([piece.slice(0, colon).trim(), piece.slice(colon + 1).trim()]);
    }
  }
  return out;
}

/**
 * @param {string} source the text of explorer/tokens.css
 * @param {{ tags?: string[] }} [opts] the corn-* tags a `theme` attribute applies to
 */
export function defaultTokensCss(source, { tags = [] } = {}) {
  const rules = parseRules(source);
  const lines = [
    '/* cornfield\'s default design tokens, generated from explorer/tokens.css by components/scripts/tokens.mjs: do not edit.',
    '   Every selector is :where(...), at zero specificity: any ordinary rule of yours (on :root, or on one element) overrides it. */',
    '',
  ];
  const emit = (r) => lines.push(`${zero(r.prelude)} {\n  ${declarationsOf(r.body).map(([k, v]) => `${k}: ${v};`).join('\n  ')}\n}`, '');
  for (const r of rules) {
    if (r.prelude.startsWith('@media')) {
      lines.push(`${r.prelude} {`);
      for (const inner of parseRules(r.body)) lines.push(`  ${zero(inner.prelude)} {\n    ${declarationsOf(inner.body).map(([k, v]) => `${k}: ${v};`).join('\n    ')}\n  }`);
      lines.push('}', '');
    } else if (r.prelude.startsWith('@')) {
      throw new Error(`tokens.css: ${r.prelude.split(' ')[0]} is not handled by the token generator`);
    } else emit(r);
  }

  // A forced mode: the light tokens as the page's own choice declares them, and the dark ones that undo exactly those.
  // A token whose value is built from others (`color-mix(... var(--corn-ok) ...)`, an alias such as `--hx-text: var(--corn-text)`) is worked out where it is
  // declared and inherited as that result: declared only on :root it would be worked out from the page's mode, not the element's. So the forced block
  // declares every such token again, on the element, to be worked out from the element's own.
  const light = rules.find((r) => r.prelude === ':root[data-theme="light"]');
  const unconditional = rules.filter((r) => r.prelude === ':root');
  const dark = unconditional[0];
  if (!light || !dark) throw new Error('tokens.css has no :root block and no :root[data-theme="light"] block');
  const lightDecls = declarationsOf(light.body);
  const darkOf = new Map(declarationsOf(dark.body));
  const darkDecls = lightDecls.map(([name]) => {
    if (name === 'color-scheme') return ['color-scheme', 'dark'];
    if (!darkOf.has(name)) throw new Error(`tokens.css: the light block sets ${name}, which the :root (dark) block does not, so a forced dark element could not undo it`);
    return [name, darkOf.get(name)];
  });
  if (!lightDecls.some(([n]) => n === 'color-scheme')) darkDecls.push(['color-scheme', 'dark']);
  const derived = new Map(unconditional.flatMap((r) => declarationsOf(r.body)).filter(([name, value]) => name.startsWith('--') && /var\(/.test(value)));
  for (const [mode, decls] of [['light', lightDecls], ['dark', darkDecls]]) {
    if (!tags.length) continue;
    const merged = new Map(decls);
    for (const [name, value] of derived) if (!merged.has(name)) merged.set(name, value);
    const sel = tags.map((t) => `:where(${t}[theme="${mode}"])`).join(',\n');
    lines.push(`/* theme="${mode}" on an element: this mode's tokens, on the element itself */`, `${sel} {\n  ${[...merged].map(([k, v]) => `${k}: ${v};`).join('\n  ')}\n}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
