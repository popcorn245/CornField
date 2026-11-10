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
import { MAX_THEME_BYTES, cssProblems, fontOrigins, clientTheme } from '../../core/theme.js';
// @ts-expect-error plain JS modules, no declarations
import { validateThemeFiles } from '../../core/validate.js';
import { CORNFIELD, SAMPLE } from '../helpers.js';

const GOOGLE = 'https://fonts.googleapis.com/css2?family=Nunito&display=swap';
const theme = (t) => configProblems({ theme: t });

describe('configProblems: theme', () => {
  it('is in the defaults, and accepts the whole key', () => {
    expect(DEFAULTS.theme).toEqual({ css: null, fonts: [], fontHosts: [], names: {}, default: null });
    expect(theme(undefined)).toEqual([]);
    expect(theme({})).toEqual([]);
    expect(theme({ css: './tools/theme.css', fonts: [GOOGLE], names: { day: './a.css', 'night-2': 'b/c.css' }, default: 'day' })).toEqual([]);
    expect(theme({ fonts: ['https://fonts.example.org/f.css'], fontHosts: ['files.example.org'] })).toEqual([]);
  });

  it('refuses a key it does not know, and anything that is not an object', () => {
    expect(theme({ script: './x.js' })).toEqual(['theme.script: the keys are css, fonts, fontHosts, names, default.']);
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

  it('tells the browser the names and the default, never a path', () => {
    expect(clientTheme({ css: './secret/theme.css', names: { a: './x/a.css', b: './x/b.css' }, default: 'a' })).toEqual({ names: ['a', 'b'], default: 'a' });
    expect(clientTheme({ css: './theme.css', names: {} })).toBeNull();
  });
});

describe('cssProblems', () => {
  it('accepts plain CSS, with comments, strings and the allow-listed @import', () => {
    const css = `/* javascript: in a comment is fine */\n@import url("${GOOGLE}");\n:root { --cf-accent: #e53e3e; }\n[data-cf="panel"]::before { content: "{ not a brace }"; }\n@media (prefers-color-scheme: dark) { :root { --cf-bg: #111; } }`;
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

  it('refuses what is not CSS: HTML, script tags, a NUL byte, unbalanced braces', () => {
    expect(cssProblems('<!doctype html><html></html>', {})[0]).toMatch(/looks like HTML/);
    expect(cssProblems('a{}\n</style><script>alert(1)</script>', {})[0]).toMatch(/looks like HTML/);
    expect(cssProblems('a{}\0', {})[0]).toMatch(/NUL byte/);
    expect(cssProblems('a { color: red;', {})[0]).toMatch(/unbalanced braces/);
    expect(cssProblems('a { color: red; } }', {})[0]).toMatch(/unbalanced braces/);
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

  it('refuses a bad theme key when the config loads', async () => {
    withTheme({ fonts: ['http://fonts.googleapis.com/css'] });
    await expect(loadConfig(root)).rejects.toThrow(/theme\.fonts\[0\] must be an https: stylesheet URL/);
  });
});
