// @vitest-environment happy-dom
/**
 * Open file (#142): a node's file on the forge. The URL (and what it refuses), the node panel choosing its primary
 * action, and axe on the panel with both actions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
// @ts-expect-error plain JS modules, no declarations
import { fileUrl } from '../../explorer/file-url.js';
// @ts-expect-error plain JS modules, no declarations
import { state } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setMap } from '../../explorer/view.js';
import * as render from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { LAYER_DEFS } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { selectNode } from '../../explorer/panels.js';
// @ts-expect-error plain JS modules, no declarations
import { showEdgePanel } from '../../explorer/proposal.js';
import { explorerPage } from '../helpers.js';

const GH = { type: 'github', url: 'https://github.com', repo: 'acme/home' };
const FJ = { type: 'forgejo', url: 'https://forge.example.test/git', repo: 'acme/home' };

describe('fileUrl', () => {
  it('builds the page of a file at a branch, per forge', () => {
    expect(fileUrl(GH, 'server/server.js', 'main')).toBe('https://github.com/acme/home/blob/main/server/server.js');
    expect(fileUrl(FJ, 'server/server.js', 'main')).toBe('https://forge.example.test/git/acme/home/src/branch/main/server/server.js');
  });

  it('links at HEAD, the default branch on both forges, when no branch is given', () => {
    expect(fileUrl(GH, 'a.js')).toBe('https://github.com/acme/home/blob/HEAD/a.js');
    expect(fileUrl(FJ, 'a.js', undefined)).toBe('https://forge.example.test/git/acme/home/src/branch/HEAD/a.js');
  });

  it('keeps a branch with a slash as two segments, and a port, a path prefix and nothing of a query or fragment', () => {
    expect(fileUrl(GH, 'a.js', 'release/1.0')).toBe('https://github.com/acme/home/blob/release/1.0/a.js');
    expect(fileUrl({ ...FJ, url: 'https://forge.example.test:8443/git/?x=1#y' }, 'a.js', 'main')).toBe('https://forge.example.test:8443/git/acme/home/src/branch/main/a.js');
  });

  it('leaves encoded and look-alike dots and slashes as file names', () => {
    expect(fileUrl(GH, '%2e%2e/x', 'main')).toBe('https://github.com/acme/home/blob/main/%252e%252e/x');
    expect(fileUrl(GH, '\uff0e\uff0e\uff0fx', 'main')).toBe('https://github.com/acme/home/blob/main/%EF%BC%8E%EF%BC%8E%EF%BC%8Fx');
    expect(fileUrl(GH, 'a.js', '%2e%2e')).toBe('https://github.com/acme/home/blob/%252e%252e/a.js');
    expect(fileUrl({ ...GH, url: 'https://github.com/a/%2e%2e/' }, 'a.js', 'main')).toBe('https://github.com/acme/home/blob/main/a.js');
  });

  it('encodes each segment and keeps the slashes', () => {
    expect(fileUrl(GH, 'docs/a b/ü#?%.md', 'feat/x y')).toBe('https://github.com/acme/home/blob/feat/x%20y/docs/a%20b/%C3%BC%23%3F%25.md');
  });

  it.each([
    ['..', '../secret'], ['a middle ..', 'a/../b'], ['a trailing ..', 'a/..'], ['a dot', './a'], ['absolute', '/etc/passwd'],
    ['a scheme', 'https://evil.test/x'], ['javascript:', 'javascript:alert(1)'], ['a backslash', 'a\\b'], ['a backslash traversal', '..\\a'],
    ['a newline', 'a\nb'], ['a NUL', 'a\u0000b'], ['a tab', 'a\tb'], ['DEL', 'a\u007fb'], ['an empty segment', 'a//b'], ['empty', ''], ['not a string', 42],
  ])('refuses a path with %s', (_why, p) => {
    expect(fileUrl(GH, p, 'main')).toBeNull();
    expect(fileUrl(FJ, p, 'main')).toBeNull();
  });

  it('refuses a branch that is not a plain name, a forge it has no shape for, anything but https, and a user name in the forge\'s URL', () => {
    expect(fileUrl(GH, 'a.js', '../x')).toBeNull();
    expect(fileUrl(GH, 'a.js', 'a\\b')).toBeNull();
    expect(fileUrl({ ...GH, type: 'gitlab' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...FJ, url: 'http://forge.example.test' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...FJ, url: 'javascript:alert(1)' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...FJ, url: 'not a url' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...GH, url: 'https://github.com@evil.test' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...GH, url: 'https://u:p@github.com' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...GH, url: 'https://evil.test\\@github.com' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...GH, type: 'constructor' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...GH, type: '__proto__' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl(GH, 'a.js', 'a//b')).toBeNull();
    expect(fileUrl(GH, '\ud800', 'main')).toBeNull();
    expect(fileUrl({ ...GH, repo: '../x' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl({ ...GH, repo: 'acme' }, 'a.js', 'main')).toBeNull();
    expect(fileUrl(null, 'a.js', 'main')).toBeNull();
  });
});

const page = explorerPage({ pieces: ['map'] });
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const node = (id, type, extra = {}) => ({ id, type, x: 0, y: 0, r: 20, color: '#336699', label: id, ...extra });
const nodes = [
  node('root', 'root'),
  node('svc-cart', 'service', { label: 'cart.js', kind: 'client', file: 'packages/web/src/cart.js' }),
  node('page-meals', 'page', { label: '/meals', file: 'packages/web/pages/meals.js', url: 'https://home.example.test/meals' }),
  node('page-bare', 'page', { label: '/bare', url: 'https://home.example.test/bare' }),
  node('svc-evil', 'service', { label: 'evil', kind: 'client', file: '../../etc/passwd' }),
];
const edges = nodes.slice(1).map((n) => ({ from: 'root', to: n.id }));

function mount(forge) {
  document.documentElement.lang = 'en';
  document.body.innerHTML = body;
  const ctx = new Proxy({}, { get: (_t, key) => (key === 'measureText' ? (t) => ({ width: t.length * 6 }) : () => {}), set: () => true });
  const canvas = document.getElementById('graph-canvas');
  canvas.getContext = () => ctx;
  Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 1000, configurable: true });
  Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 700, configurable: true });
  Object.assign(state, { canvas, ctx, proposal: null, view: 'orbit', selectedNode: null, live: null, forge });
  for (const l of LAYER_DEFS) state.activeLayers[l.key] = true;
  state.baseNodes = nodes.map((n) => ({ ...n }));
  state.baseEdges = edges;
  render.resize();
  setMap(state.baseNodes.map((n) => ({ ...n })), state.baseEdges);
}
const $ = (id) => document.getElementById(id);
const pick = (id) => selectNode(state.nodes.find((n) => n.id === id));
afterEach(() => { state.forge = null; document.body.innerHTML = ''; });

describe('the node panel\'s primary action', () => {
  it('is Open file when there is a file and a forge, and Open route is the quiet second one when there is an address too', async () => {
    mount(GH);
    await pick('page-meals');
    expect($('drawer-file-btn').hidden).toBe(false);
    expect($('drawer-file-btn').getAttribute('href')).toBe('https://github.com/acme/home/blob/HEAD/packages/web/pages/meals.js');
    expect($('drawer-file-btn').textContent).toBe('Open file ↗');
    expect($('drawer-file-btn').classList.contains('hx-open')).toBe(true);
    expect($('drawer-open-btn').hidden).toBe(false);
    expect($('drawer-open-btn').classList.contains('hx-open')).toBe(false);
    expect($('drawer-open-btn').classList.contains('hx-btn--quiet')).toBe(true);
    expect($('drawer-open-btn').getAttribute('href')).toBe('https://home.example.test/meals');
  });

  it('is Open file alone for a node with a file and no address, and uses baseBranch when the config has one', async () => {
    mount({ ...FJ, baseBranch: 'trunk' });
    await pick('svc-cart');
    expect($('drawer-file-btn').getAttribute('href')).toBe('https://forge.example.test/git/acme/home/src/branch/trunk/packages/web/src/cart.js');
    expect($('drawer-open-btn').hidden).toBe(true);
  });

  it('stays Open route, the primary one, when there is no file, no forge, or a file the rule refuses', async () => {
    mount(GH);
    await pick('page-bare');
    expect($('drawer-file-btn').hidden).toBe(true);
    expect($('drawer-open-btn').hidden).toBe(false);
    expect($('drawer-open-btn').classList.contains('hx-open')).toBe(true);
    await pick('svc-evil');
    expect($('drawer-file-btn').hidden).toBe(true);
    expect($('drawer-file-btn').hasAttribute('href')).toBe(false);
    mount(null);
    await pick('page-meals');
    expect($('drawer-file-btn').hidden).toBe(true);
    expect($('drawer-open-btn').classList.contains('hx-open')).toBe(true);
  });

  it('is gone on an edge, which has no file of its own', async () => {
    mount(GH);
    await pick('page-meals');
    showEdgePanel(state.edges.find((e) => e.to === 'page-meals'));
    expect($('drawer-file-btn').hidden).toBe(true);
    expect($('drawer-open-btn').hidden).toBe(true);
  });

  it('passes axe with both actions', async () => {
    mount(GH);
    await pick('page-meals');
    const r = await axe.run({ include: ['#spec-drawer'] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);
  });
});
