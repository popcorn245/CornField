/**
 * @module plugins/starter/toml
 *
 * A small TOML reader for the manifests the starter deriver reads (`pyproject.toml`, `Cargo.toml`): tables
 * and arrays of tables, dotted and quoted keys, strings (basic, literal and multi-line), numbers, booleans,
 * dates (kept as text), arrays and inline tables. Enough for a manifest; not a validator: it throws on
 * what it cannot read, with the line.
 */

/**
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseToml(text) {
  const src = text.replace(/\r\n/g, '\n');
  let i = 0;
  const root = {};
  let table = root;
  const line = () => src.slice(0, i).split('\n').length;
  const fail = (what) => { throw new Error(`TOML line ${line()}: ${what}`); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  const skipSpace = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; };
  const skipComment = () => { if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++; };
  /** Spaces, comments and newlines (inside an array) */
  const skipAll = () => {
    for (;;) {
      skipSpace();
      skipComment();
      if (src[i] === '\n') { i++; continue; }
      return;
    }
  };

  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  function basicString(multi) {
    let out = '';
    if (multi && src[i] === '\n') i++;
    for (;;) {
      if (i >= src.length) fail('a string is not closed');
      if (multi ? src.startsWith('"""', i) : src[i] === '"') {
        // A multi-line string may end in up to two more quotes
        if (multi) { let end = i + 3; while (src[end] === '"' && end - i < 5) end++; out += '"'.repeat(end - i - 3); i = end; } else i++;
        return out;
      }
      const c = src[i];
      if (!multi && c === '\n') fail('a string is not closed');
      if (c === '\\') {
        const n = src[i + 1];
        if (multi && /[ \t\n]/.test(n)) { i++; while (/[ \t\n]/.test(src[i])) i++; continue; }
        if (n === 'u' || n === 'U') {
          const len = n === 'u' ? 4 : 8;
          out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + len), 16));
          i += 2 + len;
          continue;
        }
        if (!(n in ESC)) fail(`unknown escape \\${n}`);
        out += ESC[n];
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
  }
  function literalString(multi) {
    if (multi && src[i] === '\n') i++;
    const end = src.indexOf(multi ? "'''" : "'", i);
    if (end < 0 || (!multi && src.slice(i, end).includes('\n'))) fail('a string is not closed');
    const out = src.slice(i, end);
    i = end + (multi ? 3 : 1);
    return out;
  }
  function string() {
    if (src.startsWith('"""', i)) { i += 3; return basicString(true); }
    if (src.startsWith("'''", i)) { i += 3; return literalString(true); }
    if (src[i] === '"') { i++; return basicString(false); }
    if (src[i] === "'") { i++; return literalString(false); }
    return null;
  }

  function key() {
    const parts = [];
    for (;;) {
      skipSpace();
      const s = src[i] === '"' || src[i] === "'" ? string() : null;
      if (s !== null) parts.push(s);
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
        if (!m) fail('a key was expected');
        parts.push(m[0]);
        i += m[0].length;
      }
      skipSpace();
      if (src[i] !== '.') return parts;
      i++;
    }
  }

  function value() {
    skipSpace();
    const s = string();
    if (s !== null) return s;
    if (src[i] === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipAll();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        skipAll();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail('an array needs a comma or a ]');
      }
    }
    if (src[i] === '{') {
      i++;
      const obj = {};
      skipSpace();
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        const k = key();
        if (src[i] !== '=') fail('an = was expected');
        i++;
        setPath(obj, k, value());
        skipSpace();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail('an inline table needs a comma or a }');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i));
    if (!m) fail('a value was expected');
    i += m[0].length;
    const raw = m[0];
    // A date and a time with a space between them
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && /^ \d{2}:/.test(src.slice(i, i + 4))) {
      const t = /^ [^\s,\]}#]+/.exec(src.slice(i))[0];
      i += t.length;
      return raw + t;
    }
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^0x[0-9a-f_]+$/i.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 16);
    if (/^[+-]?(?:inf|nan)$/.test(raw)) return raw.endsWith('inf') ? (raw.startsWith('-') ? -Infinity : Infinity) : NaN;
    return raw; // a date or a time, as text
  }

  function setPath(obj, parts, v) {
    let cur = obj;
    for (const p of parts.slice(0, -1)) {
      if (cur[p] === undefined) cur[p] = {};
      if (!isObj(cur[p])) fail(`"${p}" is not a table`);
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = v;
  }

  function tableAt(parts, array) {
    let cur = root;
    parts.forEach((p, n) => {
      const last = n === parts.length - 1;
      if (last && array) {
        if (cur[p] === undefined) cur[p] = [];
        if (!Array.isArray(cur[p])) fail(`"${p}" is not an array of tables`);
        cur[p].push({});
        cur = cur[p][cur[p].length - 1];
        return;
      }
      if (cur[p] === undefined) cur[p] = {};
      cur = Array.isArray(cur[p]) ? cur[p][cur[p].length - 1] : cur[p];
      if (!isObj(cur)) fail(`"${p}" is not a table`);
    });
    return cur;
  }

  while (i < src.length) {
    skipAll();
    if (i >= src.length) break;
    if (src[i] === '[') {
      const array = src[i + 1] === '[';
      i += array ? 2 : 1;
      const parts = key();
      if (array ? !src.startsWith(']]', i) : src[i] !== ']') fail('a table header is not closed');
      i += array ? 2 : 1;
      table = tableAt(parts, array);
    } else {
      const parts = key();
      if (src[i] !== '=') fail('an = was expected');
      i++;
      setPath(table, parts, value());
    }
    skipSpace();
    skipComment();
    if (i < src.length && src[i] !== '\n') fail('the line goes on after its value');
  }
  return root;
}
