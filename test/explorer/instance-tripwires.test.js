/**
 * @vitest-environment node
 *
 * Tripwires for spec 0011 D2: a module that runs on an instance (explorer/instance.js) must not reach anything global. Each
 * module on the CONVERTED list below fails this test if it looks an element up by document id, listens on `document` or `window`,
 * reads `location`, writes `history`, fetches a literal absolute path, or imports the shared `state` (or a bridge that stands for it),
 * however it is spelled (`?.`, `['name']`, a bare `addEventListener`, the instance's own `inst.win`); a converted module also never names
 * `document` or `window` itself. Everything a converted module imports is held to the same rules but the last.
 * Later steps add the modules they convert to the list; nothing leaves it.
 *
 * The page shell (explorer/page.js) is the one exemption: the address bar, the click on any `data-action` and the deep links are the
 * page's, not a piece's. The bridges (explorer/render.js, map-style.js, layout.js, state.js) are what the modules not yet converted import;
 * they are not on the list, and no converted module may import one.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EXPLORER } from '../helpers.js';

/** Converted modules, relative to explorer/. Add to this list; never remove from it. */
export const CONVERTED = [
  'instance.js',
  'instance-state.js',
  'engine/render.js',
  'engine/map-style.js',
  'engine/layout.js',
  'input.js',
  'frame.js',
  'camera.js',
  'scene.js',
  'labels.js',
  'spatial.js',
  'shaders.js',
  'renderer.js',
  'renderer-canvas2d.js',
  'renderer-webgl.js',
  'pieces/map.js',
  'flow-build.js',
  // Step 4 (spec 0011 D2 and D3): the three pieces around the map and what they stand on
  'pieces/node-panel.js',
  'pieces/layers.js',
  'pieces/search.js',
  'engine/piece.js',
  'engine/selection.js',
  'engine/layers.js',
  'engine/sheets.js',
  'engine/keyboard.js',
  'engine/feedback.js',
  'engine/fly.js',
  'engine/hint.js',
  'engine/strings.js',
  'engine/flow-ui.js',
  'engine/search-status.js',
  // Step 3 (spec 0011 D5, D6): where the data comes from
  'engine/source.js',
  'engine/theme-sheet.js',
  'pieces/scope.js',
  'pieces/status.js',
  'selection-view.js',
  'selection-model.js',
  'layer-model.js',
  'edge-key.js',
  'search-model.js',
  'sheet-model.js',
  'file-url.js',
  'capped.js',
  // Step 5 (spec 0011 D2 and D3): the proposal's bar, the review column with the player, the decision, and what they stand on
  'pieces/proposal.js',
  'pieces/changes.js',
  'pieces/decision.js',
  'engine/proposal.js',
  'engine/player.js',
  'engine/checks.js',
  'engine/connection.js',
  'proposal-model.js',
  'review-model.js',
  'decision-model.js',
  'scenario-list-model.js',
  'check-model.js',
  'outage-model.js',
  'scenario.js',
  'waiting-model.js',
  // The one-tag review: the composed piece and the engine function that gives an instance its map (spec 0011 D3, D4)
  'pieces/review.js',
  'engine/topology.js',
];

/** What the not-yet-converted modules import in place of an instance: no converted module may */
const BRIDGES = [
  'state.js', 'render.js', 'map-style.js', 'layout.js', // step 1
  'hint.js', 'fly.js', 'feedback.js', 'keyboard.js', 'sheets.js', 'panels.js', 'layers.js', 'search.js', 'search-status.js', 'flows.js', 'page-pieces.js', 'proposal.js', 'review-column.js', 'scenario-ui.js', 'check.js', 'review.js', 'waiting-line.js', 'connection.js', 'page-address.js', // step 5; // step 4 (strings.js is a bridge too, but it imports nothing of the page: the pure models read their words through it, and the converted modules import those)
];

/** The code of a module: comments and the contents of nothing else removed, so a word in a sentence trips nothing */
export function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|\s)\/\/\s.*$/gm, '$1');
}

/** A global the instance stands for, as code names it */
const GLOBAL = String.raw`(?:document|window|globalThis|self|top|parent)`;
/** `.name`, `?.name`, `['name']` or `?.['name']` */
const member = (names) => String.raw`\s*(?:\?\.|\.)\s*(?:${names})\b|\s*(?:\?\.)?\s*\[\s*['"\x60](?:${names})['"\x60]\s*\]`;
const LISTEN = 'addEventListener|removeEventListener';

/** The rules: what each looks for in the code of a converted module (and, but for the last, of everything it imports) */
export const RULES = {
  'looks an element up by document id': /\bgetElementById\b/,
  'listens on document or window': new RegExp([
    String.raw`\b(?:${GLOBAL.slice(3, -1)}|defaultView|ownerDocument)(?:${member(LISTEN)}|\s*(?:\?\.|\.)\s*on[a-z]+\s*=[^=])`,
    String.raw`(?<![.\w$])(?:${LISTEN})\s*\(`, // bare: the global object's own
    String.raw`\binst\s*(?:\?\.|\.)\s*(?:win|doc)(?:${member(LISTEN)}|\s*(?:\?\.|\.)\s*on[a-z]+\s*=[^=])`, // the instance's window or document
    String.raw`\blisten\s*\(\s*(?:inst\s*(?:\?\.|\.)\s*)?(?:win|doc|document|window|globalThis|self)\b`,
  ].join('|')),
  'reads location': new RegExp([
    String.raw`\b${GLOBAL}(?:${member('location')})`,
    String.raw`(?<![.\w$])location\s*(?:\?\.|\.)\s*(?:search|href|pathname|hash|origin|host|hostname|assign|replace|reload)\b`,
    String.raw`(?<![.\w$(])location\s*=(?!=)`,
    String.raw`\{[^}]*\blocation\b[^}]*\}\s*=\s*${GLOBAL}`, // const { location } = window
    String.raw`\}\s*=\s*location\b|=\s*location\s*(?:[;,)]|$)`, // const { search } = location; const l = location
    String.raw`\bdocument(?:${member('URL|baseURI|documentURI')})`,
  ].join('|'), 'm'),
  'writes history': new RegExp([
    String.raw`\b${GLOBAL}(?:${member('history')})`,
    String.raw`(?<![.\w$])history\s*(?:\?\.|\.)\s*(?:pushState|replaceState|back|forward|go)\b`,
  ].join('|')),
  'fetches a literal absolute path': /(?:(?<![.\w$])|\b(?:window|globalThis|self)\s*(?:\?\.|\.)\s*)fetch\s*(?:\?\.\s*)?\(\s*(['"`])\s*(?:\/|https?:)/,
  /** Only for the converted modules themselves (instance.js is the one that may: it is where the instance meets the page) */
  'reaches the document or window itself': /(?<![.\w$'"`])(?:document|window|globalThis|self)\s*(?:\?\.|\.|\[)/,
};
/** The rule only the converted modules are held to: the modules they import may make an offscreen canvas from `document` (glyphs.js) */
const OWN_RULES = ['reaches the document or window itself'];
/** Where a converted module may break a rule, and why */
const EXEMPT = { 'instance.js': ['reaches the document or window itself', 'listens on document or window'] }; // the instance's own window and document: onShown, fetch
/** Where a module a converted one imports may, and why. Each is code no converted module calls, in a file it imports for something else (none now: capped.js moved onto the list with the node panel) */
const CHAIN_EXEMPT = {};

/** The files a module imports (static and dynamic, relative ones), resolved */
export function importsOf(file, source = fs.readFileSync(file, 'utf8')) {
  const out = [];
  for (const m of codeOf(source).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])(\.{1,2}\/[^'"]+)\1/gm)) out.push(path.resolve(path.dirname(file), m[2]));
  return out;
}

/** The rule names a source breaks (`only`: the rules to check, default all) */
export function breaks(source, only = Object.keys(RULES)) {
  const code = codeOf(source);
  return Object.entries(RULES).filter(([name, re]) => only.includes(name) && re.test(code)).map(([name]) => name);
}

describe('the tripwires', () => {
  const bad = {
    'looks an element up by document id': "const el = document.getElementById('graph-canvas');",
    'listens on document or window': "window.addEventListener('resize', fn);",
    'reads location': "const q = location.search;",
    'writes history': "history.replaceState(null, '', url);",
    'fetches a literal absolute path': "const r = await fetch('/cornfield/config.json');",
  };

  it('each one catches the thing it is for', () => {
    for (const [rule, code] of Object.entries(bad)) expect(breaks(code, Object.keys(bad)), rule).toEqual([rule]);
    expect(breaks("document.addEventListener('click', fn)")).toContain('listens on document or window');
    expect(breaks('const here = window.location.href;')).toContain('reads location');
    expect(breaks('globalThis.history.pushState({}, "")')).toContain('writes history');
    expect(breaks('await fetch(`/x/${id}`)')).toContain('fetches a literal absolute path');
  });

  it('are not got round by optional chaining, brackets, a bare name, destructuring or the instance\'s own window', () => {
    const cases = {
      'listens on document or window': [
        "document?.addEventListener('keydown', f);", "window?.['addEventListener']('resize', f);", "addEventListener('resize', f);",
        "inst.win.addEventListener('resize', f);", "inst.doc?.addEventListener('keydown', f);", "inst.listen(inst.win, 'resize', f);",
        "inst.listen(inst.doc, 'keydown', f);", "root.ownerDocument.addEventListener('keydown', f);", "el.ownerDocument.defaultView.addEventListener('resize', f);",
        'window.onresize = f;',
      ],
      'reads location': [
        'const q = window?.location?.search;', "const q = globalThis['location'].search;", 'const { search } = location;',
        'const { location: l } = window;', 'const l = location;', 'const u = document.URL;', 'const b = new URL(document.baseURI);', 'const q = location?.search;',
      ],
      'writes history': ["history?.pushState({}, '');", "window['history'].replaceState(null, '');", 'self.history.back();'],
      'fetches a literal absolute path': ["const r = fetch?.('/cornfield/config.json');", "globalThis?.fetch('/x');"],
      'reaches the document or window itself': ["document.querySelector('#graph-canvas');", "document.documentElement.setAttribute('data-x', '');", 'getComputedStyle(document.documentElement);', "window['matchMedia']('(x)');", 'globalThis.fetch(url);'],
    };
    for (const [rule, list] of Object.entries(cases)) for (const code of list) expect(breaks(code), code).toContain(rule);
    // and still not what is not that
    expect(breaks("inst.listen(inst.root, 'keydown', fn); inst.listen(canvas, 'wheel', fn); const top = box.top; parent.children.push(n);")).toEqual([]);
    expect(breaks('const layout = `layout(location = 0) in vec2 a;`; gl.getAttribLocation(p, name);')).toEqual([]);
  });

  it('leave alone what is not that', () => {
    expect(breaks('gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);')).toEqual([]);
    expect(breaks("inst.listen(root, 'keydown', fn); root.querySelector('#x'); inst.fetch('/cornfield/config.json');")).toEqual([]);
    expect(breaks("// window.addEventListener, location.search and document.getElementById in a comment\nconst a = 1;")).toEqual([]);
    expect(breaks("/* fetch('/x') */ const b = 2;")).toEqual([]);
    expect(breaks('const hist = history; // the log')).toEqual([]);
  });
});

describe('the converted modules', () => {
  it('exist, and the list names each once', () => {
    expect(new Set(CONVERTED).size).toBe(CONVERTED.length);
    for (const rel of CONVERTED) expect(fs.existsSync(path.join(EXPLORER, rel)), rel).toBe(true);
  });

  for (const rel of CONVERTED) {
    it(`${rel} reaches nothing global`, () => {
      const rules = Object.keys(RULES).filter((r) => !(EXEMPT[rel] || []).includes(r));
      expect(breaks(fs.readFileSync(path.join(EXPLORER, rel), 'utf8'), rules)).toEqual([]);
    });
  }

  it('nor does anything they import, down the whole chain (a helper is the same code run on the instance\'s behalf)', () => {
    const converted = new Set(CONVERTED.map((rel) => path.join(EXPLORER, rel)));
    const seen = new Set();
    const problems = [];
    const walk = (file) => {
      if (seen.has(file) || !fs.existsSync(file)) return;
      seen.add(file);
      if (!converted.has(file)) {
        const allowed = CHAIN_EXEMPT[path.relative(EXPLORER, file)] || [];
        const found = breaks(fs.readFileSync(file, 'utf8'), Object.keys(RULES).filter((r) => !OWN_RULES.includes(r) && !allowed.includes(r)));
        if (found.length) problems.push(`${path.relative(EXPLORER, file)}: ${found.join(', ')}`);
      }
      for (const dep of importsOf(file)) walk(dep);
    };
    for (const rel of CONVERTED) walk(path.join(EXPLORER, rel));
    expect(seen.size).toBeGreaterThan(CONVERTED.length);
    expect(problems).toEqual([]);
  });

  it('import no shared state, no bridge to it, and nothing that does (checked down the whole import chain)', () => {
    const bridges = new Set(BRIDGES.map((b) => path.join(EXPLORER, b)));
    const seen = new Set();
    const problems = [];
    const walk = (file, via) => {
      if (seen.has(file)) return;
      seen.add(file);
      if (!file.startsWith(EXPLORER) || !fs.existsSync(file)) return; // core/ and others are pure by their own rules
      for (const dep of importsOf(file)) {
        if (bridges.has(dep)) problems.push(`${path.relative(EXPLORER, file)} imports ${path.relative(EXPLORER, dep)} (from ${via})`);
        else walk(dep, via);
      }
    };
    for (const rel of CONVERTED) walk(path.join(EXPLORER, rel), rel);
    expect(problems).toEqual([]);
  });

  it('cornfield\'s page is the one exemption: it is not on the list, and main.js only starts it', () => {
    expect(CONVERTED).not.toContain('page.js');
    expect(CONVERTED).not.toContain('main.js');
    const main = codeOf(fs.readFileSync(path.join(EXPLORER, 'main.js'), 'utf8')).trim().split('\n').filter((l) => l.trim());
    expect(main).toEqual(["import { startPage } from './page.js';", 'startPage();']);
    const page = fs.readFileSync(path.join(EXPLORER, 'page.js'), 'utf8');
    expect(page).toMatch(/export function startPage\(/);
    expect((codeOf(page).match(/startPageInstance\(/g) || []).length).toBe(1); // exactly one instance for the document, finished by one call
    expect(codeOf(fs.readFileSync(path.join(EXPLORER, 'state.js'), 'utf8')).match(/createInstance\(/g)).toHaveLength(1); // and made in one place
  });

  it('the bridges are what the unconverted modules import, and are not converted', () => {
    for (const b of BRIDGES) expect(CONVERTED).not.toContain(b);
  });
});
