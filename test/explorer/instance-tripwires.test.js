/**
 * @vitest-environment node
 *
 * Tripwires for spec 0011 D2: a module that runs on an instance (explorer/instance.js) must not reach anything global. Each
 * module on the CONVERTED list below fails this test if it looks an element up by document id, listens on `document` or `window`,
 * reads `location`, writes `history`, fetches a literal absolute path, or imports the shared `state` (or a bridge that stands for it).
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
];

/** What the not-yet-converted modules import in place of an instance: no converted module may */
const BRIDGES = ['state.js', 'render.js', 'map-style.js', 'layout.js'];

/** The code of a module: comments and the contents of nothing else removed, so a word in a sentence trips nothing */
export function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(^|\s)\/\/\s.*$/gm, '$1');
}

/** The rules: what each looks for in the code of a converted module */
export const RULES = {
  'looks an element up by document id': /\bgetElementById\b/,
  'listens on document or window': /\b(?:document|window|globalThis|self)\s*\.\s*(?:addEventListener|removeEventListener|on[a-z]+\s*=[^=])/,
  'reads location': /\b(?:window|document|globalThis|self)\s*\.\s*location\b|(?<![.\w$])location\s*\.\s*(?:search|href|pathname|hash|origin|host|hostname|assign|replace|reload)\b|(?<![.\w$(])location\s*=(?!=)/,
  'writes history': /\b(?:window|globalThis|self)\s*\.\s*history\b|(?<![.\w$])history\s*\.\s*(?:pushState|replaceState|back|forward|go)\b/,
  'fetches a literal absolute path': /(?:(?<![.\w$])|\b(?:window|globalThis|self)\s*\.\s*)fetch\s*\(\s*(['"`])\s*(?:\/|https?:)/,
};

/** The files a module imports (static and dynamic, relative ones), resolved */
export function importsOf(file, source = fs.readFileSync(file, 'utf8')) {
  const out = [];
  for (const m of codeOf(source).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])(\.{1,2}\/[^'"]+)\1/gm)) out.push(path.resolve(path.dirname(file), m[2]));
  return out;
}

/** The rule names a source breaks */
export function breaks(source) {
  const code = codeOf(source);
  return Object.entries(RULES).filter(([, re]) => re.test(code)).map(([name]) => name);
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
    for (const [rule, code] of Object.entries(bad)) expect(breaks(code), rule).toEqual([rule]);
    expect(breaks("document.addEventListener('click', fn)")).toContain('listens on document or window');
    expect(breaks('const here = window.location.href;')).toContain('reads location');
    expect(breaks('globalThis.history.pushState({}, "")')).toContain('writes history');
    expect(breaks('await fetch(`/x/${id}`)')).toContain('fetches a literal absolute path');
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
      expect(breaks(fs.readFileSync(path.join(EXPLORER, rel), 'utf8'))).toEqual([]);
    });
  }

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
