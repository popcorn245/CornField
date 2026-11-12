/**
 * @vitest-environment node
 *
 * `theme` in cornfield.config.js (docs/config.md#theme): what the config accepts, the CSS a theme file may hold, and what
 * `cornfield validate` says about the files. A theme is CSS only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain JS modules, no declarations
import { configProblems, loadConfig, DEFAULTS } from '../../core/config.js';
// @ts-expect-error plain JS modules, no declarations
import { MAX_THEME_BYTES, MAX_THEME_ASSET_BYTES, ICON_KINDS, cssProblems, cssUrls, fontOrigins, clientTheme, iconUrls, themeAssetDir, themeAssetPath, themeIconAsset, themeUrlTarget } from '../../core/theme.js';
// @ts-expect-error plain JS modules, no declarations
import { validateThemeFiles } from '../../core/validate.js';
import { CORNFIELD, SAMPLE } from '../helpers.js';

const GOOGLE = 'https://fonts.googleapis.com/css2?family=Nunito&display=swap';
const theme = (t) => configProblems({ theme: t });

describe('configProblems: theme', () => {
  it('is in the defaults, and accepts the whole key', () => {
    expect(DEFAULTS.theme).toEqual({ css: null, fonts: [], fontHosts: [], names: {}, default: null, icons: {}, pixelated: false, contrast: 'error' });
    expect(theme(undefined)).toEqual([]);
    expect(theme({})).toEqual([]);
    expect(theme({ css: './tools/theme.css', fonts: [GOOGLE], names: { day: './a.css', 'night-2': 'b/c.css' }, default: 'day' })).toEqual([]);
    expect(theme({ fonts: ['https://fonts.example.org/f.css'], fontHosts: ['files.example.org'] })).toEqual([]);
  });

  it('refuses a key it does not know, and anything that is not an object', () => {
    expect(theme({ script: './x.js' })).toEqual(['theme.script: the keys are css, fonts, fontHosts, names, default, icons, pixelated, contrast.']);
    for (const t of [null, 'x.css', ['a.css'], 3]) expect(theme(t)[0], String(t)).toMatch(/^"theme" is \{/);
  });

  it('refuses a font URL that is not an https: stylesheet URL with a plain host', () => {
    const bad = ['http://fonts.googleapis.com/css2?family=A', 'data:text/css,body{}', 'javascript:alert(1)', '//fonts.googleapis.com/css', 'ftp://fonts.example.org/a.css', 'https://user:pw@fonts.googleapis.com/css', 'https://127.0.0.1/a.css', 'https://*.example.org/a.css', 'https://fonts.googleapis.com/a b', 'https://fonts.googleapis.com/css"', 'fonts.googleapis.com/css', 7, ''];
    for (const f of bad) expect(theme({ fonts: [f] }).join('\n'), String(f)).toMatch(/theme\.fonts\[0\] must be an https: stylesheet URL/);
    expect(theme({ fonts: 'https://fonts.googleapis.com/css' })[0]).toMatch(/theme\.fonts is a list/);
  });

  it('wants theme.fontHosts when a fonts host is not a known pair, and only then', () => {
    expect(theme({ fonts: ['https://fonts.example.org/f.css'] }).join('\n')).toMatch(/does not know the font file host[\s\S]*theme\.fontHosts/);
    expect(theme({ fonts: [GOOGLE, 'https://fonts.example.org/f.css'], fontHosts: ['files.example.org'] })).toEqual([]);
    expect(theme({ fontHosts: ['files.example.org'] })).toEqual(['theme.fontHosts only goes with theme.fonts.']);
    for (const h of ['https://files.example.org', 'a b', '*.example.org', '10.0.0.1', 'x;y.example.org']) expect(theme({ fonts: [GOOGLE], fontHosts: [h] })[0], h).toMatch(/theme\.fontHosts is a list/);
  });

  it('keeps theme files inside the repo, and CSS', () => {
    for (const p of ['/etc/passwd.css', '../theme.css', 'a/../../theme.css', 'C:\\theme.css', 'theme.js', 'theme.css.js', '', 5]) expect(theme({ css: p }).join('\n'), String(p)).toMatch(/theme\.css is one stylesheet/);
    for (const p of ['../a.css', '/abs/a.css', 'a.txt']) expect(theme({ names: { a: p }, default: 'a' }).join('\n'), p).toMatch(/theme\.names\.a is a \.css file inside the repo/);
  });

  it('checks names and default for consistency', () => {
    expect(theme({ names: { 'Bad Name': './a.css' } }).join('\n')).toMatch(/theme\.names "Bad Name"/);
    expect(theme({ names: 'a.css' })[0]).toMatch(/theme\.names is \{ name/);
    expect(theme({ names: { a: './a.css' }, default: 'b' })).toEqual(['theme.default "b" is not one of theme.names (a).']);
    expect(theme({ default: 'a' })).toEqual(['theme.default "a" is not one of theme.names (none are listed).']);
    expect(theme({ names: { a: './a.css' } })).toEqual([]); // a default is optional
  });
});

describe('fontOrigins and clientTheme', () => {
  it('lists exactly the hosts: the stylesheet hosts for style-src and font-src, and the file hosts of a known pair or of fontHosts', () => {
    expect(fontOrigins({ fonts: [GOOGLE] })).toEqual({ style: ['https://fonts.googleapis.com'], font: ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'] });
    expect(fontOrigins({ fonts: ['https://fonts.example.org:8443/f.css'], fontHosts: ['files.example.org'] })).toEqual({ style: ['https://fonts.example.org:8443'], font: ['https://files.example.org', 'https://fonts.example.org:8443'] });
    expect(fontOrigins({ fonts: [] })).toEqual({ style: [], font: [] });
    expect(fontOrigins(undefined)).toEqual({ style: [], font: [] });
  });

  it('cannot be fed a CSP source with a ; a space, a quote or a wildcard, even from a config that skipped the checks', () => {
    const bad = { fonts: ['https://a.example;script-src/x.css', 'https://x.example%20y/a.css', 'https://fonts.example.org/a.css;'], fontHosts: ['a.example; script-src *', 'a b.example', "'unsafe-inline'", '*.example.org', 'files.example.org'] };
    const { style, font } = fontOrigins(bad);
    expect(style).toEqual(['https://fonts.example.org']);
    expect(font).toEqual(['https://files.example.org', 'https://fonts.example.org']);
    for (const o of [...style, ...font]) expect(o).toMatch(/^https:\/\/[a-z0-9.-]+(?::\d+)?$/);
  });

  it('tells the browser the names and the default, never a path', () => {
    expect(clientTheme({ css: './secret/theme.css', names: { a: './x/a.css', b: './x/b.css' }, default: 'a' })).toEqual({ names: ['a', 'b'], default: 'a' });
    expect(clientTheme({ css: './theme.css', names: {} })).toBeNull();
  });
});

describe('theme.icons and theme.pixelated: the config', () => {
  const T = { css: './tools/cf/theme.css' };

  it('accepts an icon per node kind, an .svg or .png inside the theme folder, and a boolean pixelated', () => {
    expect(theme({ ...T, icons: { app: './tools/cf/icons/app.svg', page: 'tools/cf/page.png', table: './tools/cf/a/b/t.PNG' }, pixelated: true })).toEqual([]);
    expect(theme({ ...T, icons: {}, pixelated: false })).toEqual([]);
    // a finer kind and a project layer have icon keys too (spec 0009 D6)
    expect(theme({ ...T, icons: { 'service:timer': './tools/cf/t.svg', 'service:web-hook': './tools/cf/h.svg', 'layer:timers': './tools/cf/l.svg' } })).toEqual([]);
    expect(ICON_KINDS).toEqual(expect.arrayContaining(['root', 'app', 'page', 'table', 'external', 'room']));
  });

  it('refuses a kind that is not a node kind, and a shape that is not a map', () => {
    expect(theme({ ...T, icons: { widget: './tools/cf/w.svg' } })[0]).toMatch(/^theme\.icons "widget": not a node type \(root, app,/);
    for (const k of ['service:', ':timer', 'service:Timer', 'service:a b', 'layer:', 'layer:Not A Key', 'widget:timer', 'service:' + 'x'.repeat(33), 'layer:x"y', 'url(x)']) expect(theme({ ...T, icons: { [k]: './tools/cf/w.svg' } })[0], k).toMatch(/^theme\.icons ".*": not a node type/);
    for (const i of [['./a.svg'], 'a.svg', 3, null]) expect(theme({ ...T, icons: i })[0], String(i)).toBe('theme.icons is { "<node type>": "./path.svg" } (or "<type>:<kind>", or "layer:<key>").');
    for (const p of [1, 'yes', null]) expect(theme({ ...T, pixelated: p }), String(p)).toEqual(['theme.pixelated is true or false.']);
  });

  it('refuses a path that is not an .svg or .png, is absolute, leaves the repo, or is outside the theme folder', () => {
    const bad = (rel) => theme({ ...T, icons: { app: rel } }).join('\n');
    for (const rel of ['/etc/a.svg', 'C:/a.svg', '../a.svg', './tools/cf/../../a.svg', 'tools\\cf\\a.svg', '', 5, null]) expect(bad(rel), String(rel)).toMatch(/theme\.icons\.app is an \.svg or \.png file inside the repo/);
    expect(bad('./tools/cf/a.gif')).toMatch(/theme\.icons\.app \(\.\/tools\/cf\/a\.gif\) is not an \.svg or \.png file/);
    expect(bad('./tools/cf/script.js')).toMatch(/is not an \.svg or \.png file/);
    expect(bad('./other/a.svg')).toMatch(/is outside the theme folder tools\/cf/);
    expect(bad('./tools/cf/.hidden/a.svg')).toMatch(/has a name that cannot be served/);
    expect(bad('./tools/cf/sp ace.svg')).toMatch(/has a name that cannot be served/);
  });

  it('wants a theme folder: there is none to serve from when the theme files are at the top of the repo, or there are none', () => {
    expect(theme({ css: './theme.css', icons: { app: './a.svg' } }).join('\n')).toMatch(/icons are served beside the theme files/);
    expect(theme({ icons: { app: './tools/cf/a.svg' } }).join('\n')).toMatch(/icons are served beside the theme files/);
    expect(theme({ names: { day: './tools/cf/day.css' }, icons: { app: './tools/cf/a.svg' } })).toEqual([]);
  });

  it('works out the served path of an icon: under the asset route, relative to the theme folder', () => {
    expect(themeIconAsset({ css: './tools/cf/theme.css' }, './tools/cf/icons/app.svg')).toEqual({ asset: 'icons/app.svg' });
    expect(iconUrls({ css: './tools/cf/theme.css', icons: { app: './tools/cf/i/app.svg', nope: './tools/cf/n.svg', page: './elsewhere/p.png' } })).toEqual({ app: '/cornfield/theme/assets/i/app.svg' });
    expect(iconUrls(undefined)).toEqual({});
  });

  it('tells the browser the served paths and the flag, and stays null for a theme with nothing the browser needs', () => {
    const t = { css: './tools/cf/theme.css', icons: { app: './tools/cf/app.svg' }, pixelated: true };
    expect(clientTheme(t)).toEqual({ names: [], default: null, icons: { app: '/cornfield/theme/assets/app.svg' }, pixelated: true });
    expect(clientTheme({ css: './tools/cf/theme.css', pixelated: true })).toEqual({ names: [], default: null, pixelated: true });
    expect(clientTheme({ css: './tools/cf/theme.css', icons: {}, pixelated: false })).toBeNull();
    expect(JSON.stringify(clientTheme(t))).not.toContain('tools/cf/app');
  });
});

describe('cssProblems', () => {
  it('accepts plain CSS, with comments, strings and the allow-listed @import', () => {
    const css = `/* javascript: in a comment is fine */\n@import url("${GOOGLE}");\n:root { --cf-accent: #e53e3e; }\n[data-corn="panel"]::before { content: "{ not a brace }"; }\n@media (prefers-color-scheme: dark) { :root { --cf-bg: #111; } }`;
    expect(cssProblems(css, { fonts: [GOOGLE] })).toEqual([]);
    expect(cssProblems('', {})).toEqual([]);
  });

  it('refuses @import of anything but an https: URL in the fonts allow-list', () => {
    const imports = ['@import "https://evil.example/x.css";', "@import url('http://fonts.googleapis.com/css2?family=Nunito');", '@import url(./other.css);', '@import "data:text/css,a{}";', '@import url(javascript:alert(1));', '@IMPORT "//evil.example/x.css";'];
    for (const i of imports) expect(cssProblems(`${i}\nbody{}`, { fonts: [GOOGLE] }).join('\n'), i).toMatch(/@import of/);
    expect(cssProblems(`@import "${GOOGLE}";`, { fonts: [] }).join('\n')).toMatch(/@import of/);
  });

  it.each([
    ['expression(', 'a { width: expression(alert(1)); }'],
    ['expression( with a space', 'a { width: expression (alert(1)); }'],
    ['javascript:', 'a { background: url(javascript:alert(1)); }'],
    ['javascript: in a string', 'a { background: url("JavaScript:alert(1)"); }'],
    ['a CSS escape', 'a { background: url(\\6a avascript:alert(1)); }'],
    ['an escaped letter', 'a { width: expr\\65ssion(1); }'],
    ['a comment splitting it', 'a { background: url(java/**/script:alert(1)); }'],
    ['behavior:', 'a { behavior: url(x.htc); }'],
    ['-moz-binding', 'a { -moz-binding: url(x.xml#y); }'],
  ])('refuses %s', (_label, css) => {
    expect(cssProblems(css, {}).length).toBeGreaterThan(0);
  });

  it.each([
    ['a comment marker in a string hiding what follows', 'a { content: "/*"; } b { width: expression(1); } c { content: "*/"; }'],
    ['an escape with its space', 'a { width: \\65 xpression(1); }'],
    ['an escaped letter in javascript:', 'a { background: url(java\\script:alert(1)); }'],
    ['an escaped at-keyword', '@\\69mport url(http://evil.example/x.css);'],
    ['@import with a comment for a gap', '@import/**/url(http://evil.example/x.css);'],
    ['@import hidden behind a string with a comment marker', '@charset "/*"; @import url(http://evil.example/x.css); /* "*/'],
    ['@import with no url()', '@import "https://evil.example/x.css";'],
    ['@import with nothing after it', '@import;'],
  ])('is not dodged by %s', (_label, css) => {
    expect(cssProblems(css, { fonts: [GOOGLE] }).length, css).toBeGreaterThan(0);
  });

  it('accepts an allow-listed @import with a comment before its url(), and braces in strings and escapes', () => {
    expect(cssProblems(`@import /* fonts */ url("${GOOGLE}");\na { content: "\\"}"; } b { content: "\\7b"; }`, { fonts: [GOOGLE] })).toEqual([]);
  });

  it('refuses what is not CSS: HTML, script tags, a NUL byte, unbalanced braces', () => {
    expect(cssProblems('<!doctype html><html></html>', {})[0]).toMatch(/looks like HTML/);
    expect(cssProblems('a{}\n</style><script>alert(1)</script>', {})[0]).toMatch(/looks like HTML/);
    expect(cssProblems('a{}\0', {})[0]).toMatch(/NUL byte/);
    expect(cssProblems('a { color: red;', {})[0]).toMatch(/unbalanced braces/);
    expect(cssProblems('a { color: red; } }', {})[0]).toMatch(/unbalanced braces/);
  });
});

describe('assets beside a theme: what a url() may name', () => {
  it('lists the url() and src() of a stylesheet, leaving out comments and @import', () => {
    expect(cssUrls(`@import url("${GOOGLE}"); /* url(no.png) */ a { background: url( "a.png" ) } b { background: url(b.svg#x) } @font-face { src: url('/cornfield/theme/assets/f.woff2') format("woff2") } c { content: "x"; mask: src(\\63 .png) }`))
      .toEqual(['a.png', 'b.svg#x', '/cornfield/theme/assets/f.woff2', 'c.png']);
  });

  it('reads a relative url() from where the file is served: /cornfield/theme.css or /cornfield/theme/<name>.css', () => {
    expect(themeUrlTarget('/cornfield/theme/assets/img/bg.png', '/cornfield/theme.css')).toEqual({ asset: 'img/bg.png' });
    expect(themeUrlTarget('/cornfield/theme/assets/img/bg.png', '/cornfield/theme/night.css')).toEqual({ asset: 'img/bg.png' });
    expect(themeUrlTarget('theme/assets/img/bg.png', '/cornfield/theme.css')).toEqual({ asset: 'img/bg.png' });
    expect(themeUrlTarget('assets/img/bg.png', '/cornfield/theme/night.css')).toEqual({ asset: 'img/bg.png' });
    expect(themeUrlTarget('./assets/f.woff2?v=2', '/cornfield/theme/night.css')).toEqual({ asset: 'f.woff2' });
    // the same words from the other file land elsewhere, and are refused
    expect(themeUrlTarget('assets/img/bg.png', '/cornfield/theme.css').problem).toMatch(/write it as \/cornfield\/theme\/assets\/<path>/);
    expect(themeUrlTarget('theme/assets/img/bg.png', '/cornfield/theme/night.css').problem).toBeTruthy();
  });

  it('accepts a data: image, and nothing from elsewhere or of another kind', () => {
    expect(themeUrlTarget('data:image/png;base64,iVBORw0KGgo=', '/cornfield/theme.css')).toEqual({ data: true });
    expect(themeUrlTarget('data:image/svg+xml,%3Csvg%3E', '/cornfield/theme.css')).toEqual({ data: true });
    for (const ref of ['', 'data:text/html,<b>', 'https://evil.example/a.png', '//evil.example/a.png', 'http://localhost/cornfield/theme/assets/a.png', '/cornfield/theme.css', '/explorer/css/base.css', 'theme/assets/a.js', 'theme/assets/a.css', 'theme/assets/a.html', 'theme/assets/%2e%2e/%2e%2e/secret.png', 'theme/assets/..%2Fsecret.png', 'theme/assets/a%5Cb.png', 'theme/assets/.git/x.png', 'theme/assets/a%00.png', 'theme/assets/%E2%80%A5/a.png', 'theme/assets/']) {
      expect(themeUrlTarget(ref, '/cornfield/theme.css').problem, ref).toBeTruthy();
    }
  });

  it('serves only plain asset names: no dot segments, backslashes, NUL, other characters or types', () => {
    expect(themeAssetPath('img/bg.png')).toBe('img/bg.png');
    expect(themeAssetPath('fonts/Pixel-Sans_2.WOFF2')).toBe('fonts/Pixel-Sans_2.WOFF2');
    for (const p of ['', '/', '../x.png', 'a/../x.png', './x.png', 'a//x.png', '/x.png', '.x.png', 'a/.git/x.png', 'a\\x.png', 'x.png\0', 'x\u2025.png', 'ｘ.png', 'x.js', 'x.css', 'x.svgz', 'x.html', 'x', 'a/b/c/d/e/f/g/h/i.png']) expect(themeAssetPath(p), p).toBeNull();
  });

  it('serves from the theme files\' folder, never from the top of the repo', () => {
    expect(themeAssetDir({ css: './tools/cornfield/theme.css' })).toBe('tools/cornfield');
    expect(themeAssetDir({ css: './tools/cornfield/theme.css', names: { a: 'tools/cornfield/names/a.css' } })).toBe('tools/cornfield');
    expect(themeAssetDir({ names: { a: 'tools/x/a.css', b: 'tools/y/b.css' } })).toBe('tools');
    expect(themeAssetDir({ css: 'theme.css' })).toBeNull();
    expect(themeAssetDir({ css: 'a/x.css', names: { b: 'b/y.css' } })).toBeNull();
    expect(themeAssetDir({})).toBeNull();
  });
});

describe('validateThemeFiles', () => {
  const made = [];
  const repo = (files, t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-'));
    made.push(root);
    for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); }
    return { root, theme: { ...DEFAULTS.theme, ...t } };
  };
  afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

  it('passes good files, and a repo with no theme', () => {
    expect(validateThemeFiles(repo({ 'theme.css': ':root{--cf-bg:#fff}', 'a.css': 'a{}' }, { css: 'theme.css', names: { a: 'a.css' }, default: 'a' }))).toEqual([]);
    expect(validateThemeFiles(repo({}, {}))).toEqual([]);
  });

  it('refuses a missing file, naming the key', () => {
    expect(validateThemeFiles(repo({}, { css: './gone.css' }))).toEqual(['theme.css (./gone.css) does not exist.']);
    expect(validateThemeFiles(repo({}, { names: { a: 'gone.css' } }))).toEqual(['theme.names.a (gone.css) does not exist.']);
  });

  it('refuses a directory, and a link that leads out of the repo', () => {
    const r = repo({ 'dir.css/x': 'a{}' }, { css: 'dir.css' });
    expect(validateThemeFiles(r)[0]).toMatch(/is not a file/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-outside-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'o.css'), 'a{}');
    const linked = repo({}, { css: 'link.css' });
    fs.symlinkSync(path.join(outside, 'o.css'), path.join(linked.root, 'link.css'));
    expect(validateThemeFiles(linked)[0]).toMatch(/leaves the repo/);
  });

  it('refuses a file over 256 KB, and says it is CSS it checks', () => {
    expect(MAX_THEME_BYTES).toBe(256 * 1024);
    expect(validateThemeFiles(repo({ 'big.css': `a{}${' '.repeat(MAX_THEME_BYTES)}` }, { css: 'big.css' }))[0]).toMatch(/is 257 KB; a theme file is at most 256 KB/);
    expect(validateThemeFiles(repo({ 'edge.css': `a{}${' '.repeat(MAX_THEME_BYTES - 3)}` }, { css: 'edge.css' }))).toEqual([]);
  });

  it('refuses the dangerous constructs and non-CSS, naming the file', () => {
    const r = repo({ 'x.css': 'a { width: expression(1); }', 'y.css': '<html></html>', 'z.css': '@import "https://evil.example/a.css";' }, { css: 'x.css', names: { y: 'y.css', z: 'z.css' } });
    const out = validateThemeFiles(r).join('\n');
    expect(out).toMatch(/theme\.css \(x\.css\) uses expression\(/);
    expect(out).toMatch(/theme\.names\.y \(y\.css\) looks like HTML/);
    expect(out).toMatch(/theme\.names\.z \(z\.css\) has an @import of "https:\/\/evil\.example\/a\.css"/);
  });
});

describe('validateThemeFiles: url() and the assets beside a theme', () => {
  const made = [];
  afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
  const repo = (files, t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-assets-'));
    made.push(root);
    for (const [name, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), data); }
    return { root, theme: { ...DEFAULTS.theme, ...t } };
  };

  it('passes url() that reach an image or font beside the theme, written absolute or relative, and data: images', () => {
    const r = repo({
      'tools/cf/theme.css': 'a { background: url(/cornfield/theme/assets/img/bg.png) } b { background: url("theme/assets/img/bg.png") } c { background: url(data:image/png;base64,iVBORw0KGgo=) } @font-face { font-family: P; src: url(theme/assets/f/p.woff2) format("woff2") }',
      'tools/cf/night.css': 'a { border-image: url(assets/img/edge.svg) 8 }',
      'tools/cf/img/bg.png': PNG, 'tools/cf/img/edge.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'tools/cf/f/p.woff2': 'wOF2',
    }, { css: 'tools/cf/theme.css', names: { night: 'tools/cf/night.css' } });
    expect(validateThemeFiles(r)).toEqual([]);
  });

  it('refuses a url() from elsewhere, of another type, missing, too big, or a link out of the theme folder', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-asset-out-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'o.png'), PNG);
    const r = repo({
      'tools/cf/theme.css': [
        'a { background: url(https://evil.example/a.png) }', 'b { background: url(bg.png) }', 'c { background: url(theme/assets/gone.png) }',
        'd { background: url(theme/assets/big.png) }', 'e { background: url(theme/assets/out.png) }', 'f { background: url(theme/assets/x.js) }',
        'g { background: url(data:text/html,hi) }',
      ].join('\n'),
      'tools/cf/bg.png': PNG, 'tools/cf/big.png': Buffer.alloc(MAX_THEME_ASSET_BYTES + 1), 'tools/cf/x.js': 'alert(1)',
    }, { css: 'tools/cf/theme.css' });
    fs.symlinkSync(path.join(outside, 'o.png'), path.join(r.root, 'tools/cf/out.png'));
    const out = validateThemeFiles(r);
    const say = out.join('\n');
    expect(say).toMatch(/url\(https:\/\/evil\.example\/a\.png\) is not an image or font served beside the theme/);
    expect(say).toMatch(/url\(bg\.png\) is not an image or font served beside the theme/);
    expect(say).toMatch(/url\(theme\/assets\/gone\.png\): tools\/cf\/gone\.png does not exist/);
    expect(say).toMatch(/url\(theme\/assets\/big\.png\): tools\/cf\/big\.png is 1025 KB; an asset beside a theme is at most 1 MB/);
    expect(say).toMatch(/url\(theme\/assets\/out\.png\): tools\/cf\/out\.png leads out of the theme folder/);
    expect(say).toMatch(/url\(theme\/assets\/x\.js\) is not an image or font/);
    expect(say).toMatch(/url\(data:text\/html,hi\) is not an image or font/);
    expect(out).toHaveLength(7);
  });

  it('says so when a theme at the top of the repo names an asset', () => {
    const r = repo({ 'theme.css': 'a { background: url(theme/assets/bg.png) }', 'bg.png': PNG }, { css: 'theme.css' });
    expect(validateThemeFiles(r)[0]).toMatch(/no theme folder serves assets/);
  });
});

describe('validateThemeFiles: theme.icons', () => {
  const made = [];
  afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d49484452', 'hex')]);
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>';
  const repo = (files, t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-icons-'));
    made.push(root);
    for (const [name, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), data); }
    return { root, theme: { ...DEFAULTS.theme, css: 'tools/cf/theme.css', ...t } };
  };
  const base = { 'tools/cf/theme.css': ':root{}' };

  it('passes an svg and a png in the theme folder', () => {
    expect(validateThemeFiles(repo({ ...base, 'tools/cf/icons/app.svg': SVG, 'tools/cf/icons/page.png': PNG }, { icons: { app: './tools/cf/icons/app.svg', page: './tools/cf/icons/page.png' }, pixelated: true }))).toEqual([]);
  });

  it('fails a missing icon, naming the kind and the file', () => {
    const errors = validateThemeFiles(repo(base, { icons: { app: './tools/cf/icons/app.svg' } }));
    expect(errors).toEqual(['theme.icons.app (./tools/cf/icons/app.svg) tools/cf/icons/app.svg does not exist.']);
  });

  it('fails a file that is not the image its name says, one with script, one too big, and a folder', () => {
    const errors = validateThemeFiles(repo({
      ...base,
      'tools/cf/a.svg': '<html></html>', 'tools/cf/b.svg': '<svg onload="x()"/>', 'tools/cf/c.svg': '<svg><script>x()</script></svg>', 'tools/cf/d.png': 'GIF89a',
      'tools/cf/big.png': Buffer.concat([PNG, Buffer.alloc(MAX_THEME_ASSET_BYTES)]), 'tools/cf/dir.svg/x.txt': 'x',
    }, { icons: { app: './tools/cf/a.svg', page: './tools/cf/b.svg', table: './tools/cf/c.svg', pkg: './tools/cf/d.png', tool: './tools/cf/big.png', atom: './tools/cf/dir.svg' } }));
    const text = errors.join('\n');
    expect(text).toMatch(/theme\.icons\.app .* is not an SVG image/);
    expect(text).toMatch(/theme\.icons\.page .* holds script/);
    expect(text).toMatch(/theme\.icons\.table .* holds script/);
    expect(text).toMatch(/theme\.icons\.pkg .* is not a PNG image/);
    expect(text).toMatch(/theme\.icons\.tool .* an asset beside a theme is at most 1 MB/);
    expect(text).toMatch(/theme\.icons\.atom .* is not a file/);
    expect(errors).toHaveLength(6);
  });

  it('fails an icon whose link leads out of the theme folder', () => {
    const r = repo({ ...base }, { icons: { app: './tools/cf/out.svg' } });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-icon-out-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'x.svg'), SVG);
    fs.symlinkSync(path.join(outside, 'x.svg'), path.join(r.root, 'tools/cf/out.svg'));
    expect(validateThemeFiles(r).join('\n')).toMatch(/theme\.icons\.app .* leads out of the theme folder/);
  });

  it('fails an icon outside the theme folder or with no theme folder, without reading the disk', () => {
    expect(validateThemeFiles(repo({ ...base, 'elsewhere/a.svg': SVG }, { icons: { app: './elsewhere/a.svg' } })).join('\n')).toMatch(/is outside the theme folder tools\/cf/);
    const top = repo({ 'theme.css': ':root{}', 'a.svg': SVG }, { css: 'theme.css', icons: { app: './a.svg' } });
    expect(validateThemeFiles(top).join('\n')).toMatch(/icons are served beside the theme files/);
  });
});

describe('cornfield validate, on a copy of the sample repo', () => {
  let root;
  const CLI = path.join(CORNFIELD, 'cli', 'cornfield.js');
  const validate = () => spawnSync(process.execPath, [CLI, 'validate', '--repo', root], { encoding: 'utf8', timeout: 60_000 });
  const withTheme = (t) => {
    const file = path.join(root, 'cornfield.config.js');
    const base = fs.readFileSync(path.join(SAMPLE, 'cornfield.config.js'), 'utf8');
    fs.writeFileSync(file, base.replace('worktrees: \'.worktrees\',', `worktrees: '.worktrees',\n  theme: ${JSON.stringify(t)},`));
  };
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-theme-cli-')); fs.cpSync(SAMPLE, root, { recursive: true }); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('passes with a good theme, and fails on a missing file, a forbidden construct and a big file', () => {
    fs.writeFileSync(path.join(root, 'theme.css'), ':root { --cf-bg: #fff; }');
    withTheme({ css: './theme.css' });
    expect(validate().status).toBe(0);
    withTheme({ css: './missing.css' });
    const missing = validate();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/theme\.css \(\.\/missing\.css\) does not exist/);
    fs.writeFileSync(path.join(root, 'theme.css'), 'a { behavior: url(x.htc); }');
    withTheme({ css: './theme.css' });
    expect(validate().stderr).toMatch(/uses behavior:/);
    fs.writeFileSync(path.join(root, 'theme.css'), `a{}${' '.repeat(MAX_THEME_BYTES)}`);
    expect(validate().stderr).toMatch(/at most 256 KB/);
  });

  it('fails on a missing icon and passes once it is there', () => {
    fs.mkdirSync(path.join(root, 'tools/cf'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools/cf/theme.css'), ':root { --corn-map-node-app: #808080; }');
    withTheme({ css: './tools/cf/theme.css', icons: { app: './tools/cf/app.svg' }, pixelated: true });
    const missing = validate();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/theme\.icons\.app \(\.\/tools\/cf\/app\.svg\) tools\/cf\/app\.svg does not exist/);
    fs.writeFileSync(path.join(root, 'tools/cf/app.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    expect(validate().status).toBe(0);
  });

  it('refuses a bad theme key when the config loads', async () => {
    withTheme({ fonts: ['http://fonts.googleapis.com/css'] });
    await expect(loadConfig(root)).rejects.toThrow(/theme\.fonts\[0\] must be an https: stylesheet URL/);
  });
});
