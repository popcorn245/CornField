/**
 * @vitest-environment node
 *
 * `brand` in cornfield.config.js (docs/config.md#brand): what the config accepts, what a brand image must be on disk
 * (`cornfield validate`), and the manifest built from it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain JS modules, no declarations
import { configProblems, DEFAULTS } from '../../core/config.js';
// @ts-expect-error plain JS modules, no declarations
import { MAX_BRAND_BYTES, brandAssetFile, brandImages, brandOn, clientBrand, colorOf, magicMatches, manifestOf, pngSize } from '../../core/brand.js';
// @ts-expect-error plain JS modules, no declarations
import { validateBrandFiles } from '../../core/validate.js';
import { CORNFIELD, SAMPLE } from '../helpers.js';

const brand = (b) => configProblems({ brand: b });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
/** A PNG header: signature, then an IHDR for a 64 x 32 image */
const png = (w = 64, h = 32) => {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

describe('configProblems: brand', () => {
  it('is in the defaults, and accepts the whole key', () => {
    expect(DEFAULTS.brand).toEqual({ logo: null, wordmark: null, favicon: null, appName: null, color: null, background: null });
    expect(brand(undefined)).toEqual([]);
    expect(brand({})).toEqual([]);
    expect(brand({ logo: './tools/logo.svg', wordmark: 'tools/word.PNG', favicon: './f.png', appName: 'Acme', color: '#e53e3e', background: '#fff' })).toEqual([]);
    expect(brand({ logo: null, appName: null, color: null })).toEqual([]);
  });

  it('refuses a key it does not know, and anything that is not an object', () => {
    expect(brand({ icon: './x.png' })).toEqual(['brand.icon: the keys are logo, wordmark, favicon, appName, color, background.']);
    for (const b of [null, 'logo.svg', ['a.svg'], 3]) expect(brand(b)[0], String(b)).toMatch(/^"brand" is \{/);
  });

  it('wants an .svg or .png path inside the repo for each image', () => {
    for (const k of ['logo', 'wordmark', 'favicon']) {
      for (const p of ['/etc/logo.png', '../logo.png', 'a/../../b.svg', 'C:\\logo.png', 'logo.jpg', 'logo.ico', 'logo.html', 'logo', 'logo.svg\0.png', '', '  ', 7, ['a.png']]) {
        expect(brand({ [k]: p })[0], `${k} ${JSON.stringify(p)}`).toMatch(new RegExp(`^brand\\.${k} is one image`));
      }
    }
  });

  it('wants appName to be short text on one line', () => {
    for (const n of ['', '   ', 'a'.repeat(65), 'two\nlines', 'tab\there', 7, {}]) expect(brand({ appName: n })[0], JSON.stringify(n)).toMatch(/^brand\.appName is text of at most 64/);
    expect(brand({ appName: 'a'.repeat(64) })).toEqual([]);
  });

  it('wants colours that are hex', () => {
    for (const k of ['color', 'background']) {
      for (const c of ['red', 'e53e3e', '#e53e3', '#e53e3e0', '#e53e3e80', '#ggg', 'rgb(1,2,3)', 'url(x)', '#fff; x', 7, '']) expect(brand({ [k]: c })[0], `${k} ${JSON.stringify(c)}`).toMatch(new RegExp(`^brand\\.${k} is a hex colour`));
      for (const c of ['#fff', '#FFF', '#e53e3e', '#E53E3E']) expect(brand({ [k]: c })).toEqual([]);
    }
  });
});

describe('what a brand names', () => {
  it('lists the images with their served URLs, in the extension of the file', () => {
    expect(brandImages({ logo: './a/Logo.SVG', favicon: 'f.png', wordmark: null })).toEqual([
      { key: 'logo', rel: './a/Logo.SVG', url: '/cornfield/brand/logo.svg', type: 'image/svg+xml' },
      { key: 'favicon', rel: 'f.png', url: '/cornfield/brand/favicon.png', type: 'image/png' },
    ]);
    expect(brandOn(DEFAULTS.brand)).toBe(false);
    expect(brandOn({ ...DEFAULTS.brand, color: '#fff' })).toBe(true);
  });

  it('tells the browser URLs and the name, never a path', () => {
    expect(clientBrand(DEFAULTS.brand, 'https://x.example/')).toBeNull();
    const out = clientBrand({ ...DEFAULTS.brand, logo: './secret/dir/logo.svg', appName: ' Acme ' }, 'https://x.example/');
    expect(out).toEqual({ logo: '/cornfield/brand/logo.svg', wordmark: null, favicon: null, appName: 'Acme', poweredBy: 'https://x.example/' });
    expect(JSON.stringify(out)).not.toContain('secret');
  });
});

describe('magic bytes', () => {
  it('knows a PNG and an SVG by their first bytes', () => {
    expect(magicMatches('.png', png())).toBe(true);
    expect(magicMatches('.png', Buffer.from(SVG))).toBe(false);
    expect(magicMatches('.png', Buffer.from('<html></html>'))).toBe(false);
    // the signature alone is not enough: an IHDR chunk has to follow it, so a signature glued onto a page or an SVG is refused
    const sig = Buffer.from('89504e470d0a1a0a', 'hex');
    expect(magicMatches('.png', Buffer.concat([sig, Buffer.from('<html><script>alert(1)</script></html>')]))).toBe(false);
    expect(magicMatches('.png', Buffer.concat([sig, Buffer.from(SVG)]))).toBe(false);
    expect(magicMatches('.png', png().subarray(0, 32))).toBe(false);
    expect(magicMatches('.svg', Buffer.from(SVG))).toBe(true);
    expect(magicMatches('.svg', Buffer.from(`\uFEFF<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG}`))).toBe(true);
    for (const bad of ['<html><svg></svg></html>', '<svgx/>', '<script>alert(1)</script>', '', 'plain text', '<?xml version="1.0"?><html/>']) expect(magicMatches('.svg', Buffer.from(bad)), bad).toBe(false);
    expect(magicMatches('.svg', png())).toBe(false);
    expect(magicMatches('.gif', Buffer.from('GIF89a'))).toBe(false);
  });

  it('reads a PNG\'s size from its header', () => {
    expect(pngSize(png(192, 96))).toEqual({ width: 192, height: 96 });
    expect(pngSize(png(0, 5))).toBeNull();
    expect(pngSize(Buffer.from(SVG))).toBeNull();
  });
});

describe('the manifest', () => {
  const files = { 'f.png': png(32, 32), 'l.svg': Buffer.from(SVG), 'l2.png': png(512, 512) };
  const read = (rel) => (files[rel] ? { body: files[rel] } : { problem: 'does not exist.' });

  it('is the repo\'s title with no icons when there is no brand', () => {
    for (const b of [null, undefined, {}]) expect(manifestOf(b, 'Acme home', read)).toEqual({ name: 'Acme home', short_name: 'Acme home', start_url: '/', display: 'standalone', icons: [] });
  });

  it('carries a colour only when it is a hex colour, even if the config was never checked', () => {
    const m = manifestOf({ color: 'red"}', background: 'url(x)' }, 'repo', read);
    expect(m).not.toHaveProperty('theme_color');
    expect(m).not.toHaveProperty('background_color');
    expect(colorOf('#e53e3e')).toBe('#e53e3e');
    for (const bad of ['red', '"><script>', '#e53e3e80', null, 7]) expect(colorOf(bad)).toBeNull();
  });

  it('takes its name from appName, or the repo\'s title, and starts standalone at /', () => {
    expect(manifestOf({ appName: 'Acme' }, 'repo', read)).toEqual({ name: 'Acme', short_name: 'Acme', start_url: '/', display: 'standalone', icons: [] });
    expect(manifestOf({ logo: 'l.svg' }, 'My long repo title', read)).toMatchObject({ name: 'My long repo title', short_name: 'My long repo' });
  });

  it('lists the favicon and the logo as icons, with their sizes, and not the wordmark', () => {
    const m = manifestOf({ favicon: 'f.png', logo: 'l.svg', wordmark: 'l2.png' }, 'repo', read);
    expect(m.icons).toEqual([
      { src: '/cornfield/brand/favicon.png', type: 'image/png', sizes: '32x32', purpose: 'any' },
      { src: '/cornfield/brand/logo.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any' },
    ]);
    expect(manifestOf({ favicon: 'gone.png' }, 'repo', read).icons).toEqual([]);
  });

  it('carries the colours only when the config sets them', () => {
    expect(manifestOf({ color: '#e53e3e', background: '#fff' }, 'repo', read)).toMatchObject({ theme_color: '#e53e3e', background_color: '#fff' });
    const m = manifestOf({ appName: 'A' }, 'repo', read);
    expect(m).not.toHaveProperty('theme_color');
    expect(m).not.toHaveProperty('background_color');
  });
});

describe('brandAssetFile and validateBrandFiles', () => {
  const made = [];
  const repo = (files, b) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-brand-'));
    made.push(root);
    for (const [name, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), data); }
    return { root, brand: { ...DEFAULTS.brand, ...b } };
  };
  afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

  it('passes good images, and a repo with no brand', () => {
    expect(validateBrandFiles(repo({ 'l.svg': SVG, 'w.png': png(), 'f.PNG': png() }, { logo: './l.svg', wordmark: 'w.png', favicon: 'f.PNG' }))).toEqual([]);
    expect(validateBrandFiles(repo({}, {}))).toEqual([]);
  });

  it('refuses a missing file, naming the key', () => {
    expect(validateBrandFiles(repo({}, { logo: './gone.svg' }))).toEqual(['brand.logo (./gone.svg) does not exist.']);
  });

  it('refuses a directory, and a link that leads out of the repo', () => {
    expect(validateBrandFiles(repo({ 'dir.png/x': 'x' }, { favicon: 'dir.png' }))[0]).toMatch(/^brand\.favicon \(dir\.png\) is not a file/);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-brand-out-'));
    made.push(outside);
    fs.writeFileSync(path.join(outside, 'o.png'), png());
    const linked = repo({}, { logo: 'link.png' });
    fs.symlinkSync(path.join(outside, 'o.png'), path.join(linked.root, 'link.png'));
    expect(validateBrandFiles(linked)[0]).toMatch(/leaves the repo/);
    // a link that stays inside is fine
    const inside = repo({ 'real.png': png() }, { logo: 'alias.png' });
    fs.symlinkSync(path.join(inside.root, 'real.png'), path.join(inside.root, 'alias.png'));
    expect(validateBrandFiles(inside)).toEqual([]);
  });

  it('refuses an extension that is not allowed', () => {
    expect(validateBrandFiles(repo({ 'a.jpg': png() }, { logo: 'a.jpg' }))[0]).toMatch(/is not an \.svg or \.png file/);
  });

  it('refuses a file whose bytes are not what its extension says', () => {
    const r = repo({ 'page.png': '<html><script>alert(1)</script></html>', 'fake.svg': png(), 'text.svg': 'hello' }, { logo: 'page.png', wordmark: 'fake.svg', favicon: 'text.svg' });
    const out = validateBrandFiles(r);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('brand.logo (page.png) is not really a PNG (its first bytes do not match its .png extension).');
    expect(out[1]).toMatch(/^brand\.wordmark \(fake\.svg\) is not really an SVG/);
    expect(out[2]).toMatch(/^brand\.favicon \(text\.svg\) is not really an SVG/);
  });

  it('refuses a file over 512 KB, and takes one of exactly 512 KB', () => {
    expect(MAX_BRAND_BYTES).toBe(512 * 1024);
    const pad = (n) => Buffer.concat([png(), Buffer.alloc(n - 33)]);
    expect(validateBrandFiles(repo({ 'big.png': pad(MAX_BRAND_BYTES + 1) }, { logo: 'big.png' }))[0]).toMatch(/is 513 KB; a brand image is at most 512 KB/);
    expect(validateBrandFiles(repo({ 'edge.png': pad(MAX_BRAND_BYTES) }, { logo: 'edge.png' }))).toEqual([]);
    expect(brandAssetFile(repo({ 'edge.png': pad(MAX_BRAND_BYTES) }, {}).root, 'edge.png')).toMatchObject({ type: 'image/png', size: MAX_BRAND_BYTES });
  });
});

describe('cornfield validate, on a copy of the sample repo', () => {
  const CLI = path.join(CORNFIELD, 'cli', 'cornfield.js');
  let root;
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('passes with a good logo, and fails on one whose bytes do not match', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-brand-cli-'));
    fs.cpSync(SAMPLE, root, { recursive: true });
    const configFile = path.join(root, 'cornfield.config.js');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace("worktrees: '.worktrees',", () => "worktrees: '.worktrees',\n  brand: { logo: './logo.png', appName: 'Acme' },"));
    const validate = () => spawnSync(process.execPath, [CLI, 'validate', '--repo', root], { encoding: 'utf8', timeout: 60_000 });
    fs.writeFileSync(path.join(root, 'logo.png'), png());
    expect(validate().status).toBe(0);
    fs.writeFileSync(path.join(root, 'logo.png'), '<html></html>');
    const bad = validate();
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toMatch(/brand\.logo \(\.\/logo\.png\) is not really a PNG/);
  });
});
