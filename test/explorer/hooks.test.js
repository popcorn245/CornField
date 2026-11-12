// @vitest-environment happy-dom
/**
 * The styling hooks (docs/theming.md, "Styling hooks"): every region and component carries a `data-corn="…"` value, and
 * the documented list is the public API. This fails when a hook is in the docs but not in the markup, when the markup has
 * a value the docs do not list, and when the real page and its panels lose the main ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CORNFIELD, EXPLORER, explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { state, escHtml } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { setRenderer } from '../../explorer/render.js';
// @ts-expect-error plain JS modules, no declarations
import { renderLayerToggles } from '../../explorer/layers.js';
// @ts-expect-error plain JS modules, no declarations
import { ensurePagePieces } from '../../explorer/page-pieces.js';
// @ts-expect-error plain JS modules, no declarations
import { proposalRowHtml } from '../../explorer/proposal.js';
// @ts-expect-error plain JS modules, no declarations
import { runsHtml } from '../../explorer/runs-view.js';
// @ts-expect-error plain JS modules, no declarations
import { mockupsSectionHtml } from '../../explorer/mockups-model.js';
import { initScenarioUi, playScenario, clearScenario } from '../../explorer/scenario-ui.js';
// @ts-expect-error plain JS modules, no declarations
import { applyBranding } from '../../explorer/plugins.js';
// @ts-expect-error plain JS modules, no declarations
import { CORN_STATES, MARK_STATES, cornState, markState, markStateAttr } from '../../explorer/corn-state.js';

const docs = fs.readFileSync(path.join(CORNFIELD, 'docs', 'theming.md'), 'utf8');
/** The first-column values (in backticks) of the tables in a section of the docs, from its heading to the next heading of its level or higher */
function tableValues(heading) {
  const level = heading.match(/^#+/)[0].length;
  const at = docs.indexOf(`\n${heading}`);
  if (at < 0) throw new Error(`docs/theming.md has no "${heading}"`);
  const rest = docs.slice(at + 1 + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  const section = end < 0 ? rest : rest.slice(0, end);
  const out = [];
  for (const line of section.split('\n')) {
    const cell = /^\|\s*([^|]+?)\s*\|/.exec(line);
    if (cell && !/^-+$/.test(cell[1])) out.push(...[...cell[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
  }
  return out;
}
// The hooks are under "## The hooks" and its "###" groups; read the whole section
const hooks = tableValues('## The hooks').filter((v, i, a) => a.indexOf(v) === i);
const kinds = tableValues('### Button kinds: `data-corn-kind`');
const states = tableValues('### States: `data-corn-state`');

// The pieces (explorer/pieces/) and the engine (explorer/engine/) hold markup too: the node panel's, the Layers menu's and the search's
const SOURCES = [path.join(EXPLORER, 'index.html'), ...['.', 'pieces', 'engine'].flatMap((d) => fs.readdirSync(path.join(EXPLORER, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(EXPLORER, d, f))), path.join(CORNFIELD, 'plugins/house/browser.js'), path.join(CORNFIELD, 'server/auth.js')]; // the sign-in pages (server/auth.js) are markup too
const source = SOURCES.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
/** Every literal value written as `data-corn="x"` or `dataset.corn = 'x'` (the attribute, in markup and in script) */
const literal = (name, re) => [...source.matchAll(re)].map((m) => m[1]);
// explorer/plugins.js sets the brand images' hook from the image's kind: setAttribute('data-corn', `brand-${kind}`), kind 'logo' or 'wordmark'
const brandImages = /setAttribute\('data-corn', `brand-\$\{kind\}`\)/.test(source) && /brandImage\(doc, [^)]*'logo'/.test(source) && /brandImage\(doc, [^)]*'wordmark'/.test(source) ? ['brand-logo', 'brand-wordmark'] : [];
const used = [...new Set([...literal('attr', /\bdata-corn="([^"$]+)"/g), ...literal('js', /\.dataset\.corn = '([^']+)'/g), ...literal('set', /setAttribute\('data-corn', '([^']+)'\)/g), ...brandImages])];
const usedKinds = [...new Set(literal('kind', /\bdata-corn-kind="([^"$]+)"/g))];
// Most states are worked out by corn-state.js; the rest are written as literals
const usedStates = [...new Set([...literal('attr', /\bdata-corn-state="([^"$]+)"/g), ...literal('js', /\.dataset\.cornState = '([^']+)'/g)])];
const usedKindsJs = [...new Set(literal('kind', /\.dataset\.cornKind = '([^']+)'/g))];

describe('the documented list', () => {
  it('is a list a brand can read in one sitting, with no repeats', () => {
    expect(hooks.length).toBeGreaterThanOrEqual(100);
    expect(hooks.length).toBeLessThanOrEqual(200);
    const all = tableValues('## The hooks');
    expect(all.length).toBe(hooks.length);
    expect(kinds.sort()).toEqual(['approve', 'danger', 'icon', 'primary', 'quiet', 'secondary']);
  });

  it('documents exactly the states corn-state.js gives, one value per meaning', () => {
    expect([...states].sort()).toEqual([...CORN_STATES].sort());
    expect(states.length).toBe(new Set(states).size);
  });

  it('says renaming a hook is breaking, and that there is no shadow DOM', () => {
    expect(docs).toMatch(/renaming or removing one is a breaking change/);
    expect(docs).toMatch(/No shadow DOM/);
  });

  it('has every hook in index.html or the explorer source', () => {
    const missing = hooks.filter((h) => !used.includes(h));
    expect(missing, `documented but in no markup: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the markup', () => {
  it('has no data-corn value that the docs do not list', () => {
    const extra = used.filter((h) => !hooks.includes(h));
    expect(extra, `in the markup but not documented: ${extra.join(', ')}`).toEqual([]);
  });

  it('has no data-corn-kind or data-corn-state value that the docs do not list', () => {
    expect([...usedKinds, ...usedKindsJs].filter((k) => !kinds.includes(k))).toEqual([]);
    expect(usedStates.filter((s) => !states.includes(s))).toEqual([]);
  });

  it('writes every hook as a short kebab-case noun', () => {
    for (const h of [...hooks, ...used]) expect(h, h).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it('does not use the old data-cf prefix anywhere in the explorer, the server or the core', () => {
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html|css|md)$/.test(e.name)) files.push(p); } };
    for (const d of ['explorer', 'server', 'core']) walk(path.join(CORNFIELD, d));
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/data-cf\b/);
  });
});

describe('every control has a hook', () => {
  // A button, link, field or disclosure in the markup (index.html, the explorer's script, the house plugin, the sign-in pages) is found by a
  // `data-corn`, or by its `data-corn-kind` when it is an ordinary button; one with neither is a part a brand cannot single out
  const CONTROL = /<(button|a|input|select|textarea|summary)\b([^>]*)>/g;
  /** Every control tag in a source, with its line, leaving out what a comment says */
  function controls(file) {
    const text = fs.readFileSync(file, 'utf8');
    const out = [];
    for (const m of text.matchAll(CONTROL)) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const before = text.slice(lineStart, m.index);
      if (/^\s*(\*|\/\/|<!--)/.test(before)) continue; // a comment (a JSDoc line, a note) naming a tag
      out.push({ el: m[1], tag: m[0], line: text.slice(0, m.index).split('\n').length });
    }
    return out;
  }
  const rel = (f) => path.relative(CORNFIELD, f);

  it('has a data-corn on every link, field, select and disclosure, and a data-corn or a data-corn-kind on every button', () => {
    const missing = [];
    for (const file of SOURCES) {
      for (const { el, tag, line } of controls(file)) {
        if (/\btype="hidden"/.test(tag)) continue;
        const hasCorn = /\bdata-corn="/.test(tag);
        const hasKind = /\bdata-corn-kind="/.test(tag);
        // A link that is a button drawn as a link (the sign-in pages' Sign in) names its kind; every other control names a part
        if (el === 'button' || (el === 'a' && /\bcf-button\b/.test(tag))) { if (!hasCorn && !hasKind) missing.push(`${rel(file)}:${line} ${tag.slice(0, 90)}`); } else if (!hasCorn) missing.push(`${rel(file)}:${line} ${tag.slice(0, 90)}`);
      }
    }
    expect(missing, `controls with no hook:\n${missing.join('\n')}`).toEqual([]);
  });

  // A control made by script: `x = document.createElement('button')`, and then a hook or a kind set on `x` itself in the lines that build it
  // (the receiver may be dotted: the pieces make elements with `inst.doc.createElement`)
  const MADE = /(?:\b([A-Za-z_$][\w$]*)\s*=\s*)?\b[\w.]+\.createElement\((['"`])(button|a|input|select|textarea|summary)\2\)/g;
  /** The line of each control a source makes by script with no `data-corn` or `data-corn-kind` of its own */
  function unhookedMade(text) {
    const out = [];
    for (const m of text.matchAll(MADE)) {
      const name = m[1];
      const next = text.slice(m.index).split('\n').slice(0, 30).join('\n');
      const own = !!name && new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\.(dataset\\.corn(Kind)?\\s*=|setAttribute\\('data-corn(-kind)?')`).test(next);
      if (!own) out.push(text.slice(0, m.index).split('\n').length);
    }
    return out;
  }

  it('gives a button made by script a hook or a kind too', () => {
    const missing = [];
    for (const file of SOURCES) for (const line of unhookedMade(fs.readFileSync(file, 'utf8'))) missing.push(`${rel(file)}:${line}`);
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('finds a control made by script with no hook, even next to one that has one', () => {
    const probe = "const zoom = document.createElement('button');\nzoom.type = 'button';\nconst close = document.createElement(\"button\");\nclose.dataset.cornKind = 'quiet';\nel.append(doc.createElement('a'));\nconst ok = document.createElement('input');\nok.setAttribute('data-corn', 'control');";
    expect(unhookedMade(probe)).toEqual([1, 5]);
  });

  it('names a button\'s importance in a kind: no ordinary button is without one', () => {
    // A button with its own hook (a tab, a chip, a row) is a part; an ordinary action is `secondary` at least
    const bare = [];
    for (const file of SOURCES) {
      for (const { el, tag, line } of controls(file)) {
        if (el !== 'button' || /\bdata-corn="/.test(tag) || /\bdata-corn-kind="/.test(tag)) continue;
        bare.push(`${rel(file)}:${line}`);
      }
    }
    expect(bare).toEqual([]);
  });
});

describe('the parts 0.35 added hooks to', () => {
  // [source, hook, how it is written there]: the hook has to stay on the real element, in markup made by script too
  const PLACES = [
    ['explorer/index.html', 'preset-map', /id="preset-map-btn"[^>]*data-corn="preset-map"|data-corn="preset-map"[^>]*id="preset-map-btn"/],
    ['explorer/index.html', 'view-switch', /class="hx-view"[^>]*data-corn="view-switch"/],
    ['explorer/index.html', 'fit-button', /id="fit-btn"[^>]*data-corn="fit-button"/],
    ['explorer/index.html', 'avatar', /id="account-initial"[^>]*data-corn="avatar"/],
    ['explorer/index.html', 'account-who', /id="account-who"[^>]*data-corn="account-who"/],
    ['explorer/index.html', 'account-row', /class="hx-account-row" data-corn="account-row"/],
    ['explorer/index.html', 'theme-option', /data-choice="system"/],
    ['explorer/index.html', 'proposal-title', /id="proposal-title"[^>]*data-corn="proposal-title"/],
    ['explorer/index.html', 'proposal-counts', /id="proposal-chip"[^>]*data-corn="proposal-counts"/],
    ['explorer/index.html', 'proposal-mode', /id="proposal-mode"[^>]*data-corn="proposal-mode"/],
    ['explorer/index.html', 'compare', /id="proposal-seg"[^>]*data-corn="compare"/],
    ['explorer/index.html', 'filter-chip', /data-corn="filter-chip"[^>]*id="forge-filter-chip"/],
    ['explorer/pieces/node-panel.js', 'diff-pill', /id="drawer-diff"[^>]*data-corn="diff-pill"/],
    ['explorer/review.js', 'review-note', /<textarea data-corn="review-note" id="review-note"/],
    ['explorer/capped.js', 'more', /<button data-corn="more" data-corn-kind="quiet"/],
    ['explorer/forge-panel.js', 'tag', /class="hx-forge-label" data-corn="tag"/],
    ['explorer/forge-panel.js', 'out-link', /data-corn="out-link" class="hx-forge-out"/],
    ['explorer/forge-panel.js', 'back', /<button data-corn="back"/],
    ['explorer/forge-panel.js', 'detail-title', /class="hx-forge-detail-title" data-corn="detail-title"/],
    ['explorer/forge-panel.js', 'node-chip', /<button data-corn="node-chip"/],
    ['explorer/forge-panel.js', 'file', /class="hx-forge-file" data-corn="file"/],
    ['explorer/runs-view.js', 'run-actions', /class="hx-run-actions" data-corn="run-actions"/],
    ['explorer/pieces/node-panel.js', 'diff-block', /class="hx-diff hx-diff--\$\{escHtml\(kind\)\}" data-corn="diff-block"/],
    ['explorer/live.js', 'live-chip state', /btn\.dataset\.cornState = live/],
  ];
  for (const [file, name, re] of PLACES) {
    it(`keeps ${name} in ${file}`, () => {
      expect(fs.readFileSync(path.join(CORNFIELD, file), 'utf8')).toMatch(re);
    });
  }

  it('gives Send back and Edit a kind (secondary), and the run actions theirs', () => {
    expect(source).toMatch(/data-corn-kind="secondary"[^>]*data-review="notes"|data-review="notes"[^>]*data-corn-kind="secondary"/);
    expect(source).toMatch(/id="proposal-edit"[^>]*data-corn-kind="secondary"|data-corn-kind="secondary"[^>]*id="proposal-edit"/);
    expect(fs.readFileSync(path.join(EXPLORER, 'runs-view.js'), 'utf8').match(/data-corn-kind="secondary"/g).length).toBeGreaterThanOrEqual(7);
  });

  it('tells the four marks of a diff apart as states, and keeps a changed mockup waiting', () => {
    expect([...MARK_STATES].sort()).toEqual(['added', 'changed', 'edit', 'removed']);
    for (const m of MARK_STATES) { expect(markState(m)).toBe(m); expect(states).toContain(m); }
    expect(markState('none')).toBe('');
    expect(markState(undefined)).toBe('');
    expect(markStateAttr('removed')).toBe(' data-corn-state="removed"');
    expect(markStateAttr('none')).toBe('');
    expect(cornState('changed')).toBe('waiting'); // a mockup that changed since it was reviewed: not a diff mark
    expect(cornState('added')).toBe('');
  });

  it('maps the live chip\'s tones onto states', () => {
    expect(['ok', 'stale', 'off', 'error', 'idle'].map(cornState)).toEqual(['success', 'waiting', 'stopped', 'failure', 'running']);
  });
});

describe('the retro fixture theme, the proof that hooks are enough', () => {
  const css = fs.readFileSync(path.join(CORNFIELD, 'test', 'fixtures', 'themes', 'retro', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').map((r) => r.split('{')).filter((r) => r.length === 2 && !/^\s*(@|:root)/.test(r[0]) && /\[data-corn/.test(r[0]));

  it('styles with hooks, kinds and states alone: no class, no id, no !important', () => {
    expect(css).not.toMatch(/!important/);
    for (const [selector] of rules) {
      expect(selector, selector).not.toMatch(/\.hx-|\.cf-|#[a-z]/i);
    }
    expect(rules.length).toBeGreaterThan(30);
  });

  it('names only hooks, kinds and states the docs list', () => {
    const named = (attr) => [...css.matchAll(new RegExp(`\\[${attr}[\\^$*]?=\\"([a-z0-9-]+)\\"\\]`, 'g'))].map((m) => m[1]);
    const corn = named('data-corn').filter((v) => v !== 'preset-' && v !== '-dialog'); // `^="preset-"` and `$="-dialog"` are prefixes and suffixes
    expect(corn.filter((h) => !hooks.includes(h))).toEqual([]);
    expect(named('data-corn-kind').filter((k) => !kinds.includes(k))).toEqual([]);
    expect(named('data-corn-state').filter((v) => !states.includes(v))).toEqual([]);
  });

  it('reaches what it could not before: secondary buttons, the compare control, the Filter chip, node chips, the diff pill', () => {
    for (const part of ['[data-corn-kind="secondary"]', '[data-corn="compare"]', '[data-corn="compare-option"]', '[data-corn="filter-chip"]', '[data-corn="node-chip"]', '[data-corn="diff-pill"][data-corn-state="removed"]', '[data-corn="live-chip"][data-corn-state="failure"]']) expect(css, part).toContain(part);
  });
});

// --- The page and some panels, mounted -------------------------------------------------------------------------------

const html = explorerPage({ pieces: ['map'] }); // the map's markup in place, the other pieces' places: page.js mounts them (page-pieces.js), and so does each test below
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const $ = (sel) => document.querySelector(sel);
const hook = (name) => $(`[data-corn="${name}"]`);

describe('the mounted page', () => {
  beforeEach(() => { document.body.innerHTML = body; ensurePagePieces(); });

  it('has the main regions, each on its real element', () => {
    expect(hook('header').tagName).toBe('HEADER');
    expect(hook('stage').getAttribute('role')).toBe('main');
    expect(hook('map-canvas')).toBe(document.getElementById('graph-canvas'));
    expect(hook('label-canvas')).toBe(document.getElementById('label-canvas'));
    expect(hook('run-overlay')).toBe(document.getElementById('run-overlay'));
    expect(hook('search-input')).toBe(document.getElementById('node-search'));
    expect(hook('layers-button')).toBe(document.getElementById('legend-toggle-btn'));
    expect(hook('layers-menu')).toBe(document.getElementById('legend-dropdown'));
    expect(hook('preset-dataflow')).toBe(document.getElementById('preset-dataflow-btn'));
    expect(hook('preset-house')).toBe(document.getElementById('preset-house-btn'));
    expect(hook('proposals-button')).toBe(document.getElementById('proposal-btn'));
    expect(hook('forge-button')).toBe(document.getElementById('forge-btn'));
    expect(hook('theme-toggle').getAttribute('aria-labelledby')).toBe('theme-label');
    expect(hook('links')).toBe(document.getElementById('cf-links'));
    expect(hook('account-button')).toBe(document.getElementById('account-btn'));
    expect(hook('account-menu')).toBe(document.getElementById('account-menu'));
    expect(hook('account-menu').contains(hook('proposals-button'))).toBe(true);
    expect(hook('zoom')).toBeNull(); // the zoom buttons are gone (CF-41)
  });

  it('has the header\'s View switch in full: Map, Flow, House, then Fit; and the account menu\'s theme options', () => {
    expect([...hook('view-switch').querySelectorAll('[data-corn]')].map((e) => e.getAttribute('data-corn'))).toEqual(['preset-map', 'preset-dataflow', 'preset-house', 'fit-button']);
    expect(hook('fit-button').getAttribute('data-corn-kind')).toBe('icon');
    expect(hook('avatar').closest('[data-corn="account-button"]')).not.toBeNull();
    expect(hook('account-menu').contains(hook('account-who'))).toBe(true);
    const options = [...hook('theme-toggle').querySelectorAll('[data-corn="theme-option"]')];
    expect(options.map((o) => o.getAttribute('data-choice'))).toEqual(['system', 'dark', 'light']);
    for (const o of options) expect(['true', 'false']).toContain(o.getAttribute('aria-pressed'));
    expect(hook('account-menu').contains(hook('account-row'))).toBe(true);
  });

  it('has the proposal bar\'s toolbar in full (name, counts, Before / Diff / After, Edit) and the review column\'s decision (Send back, Approve)', () => {
    const bar = hook('proposal-bar');
    for (const name of ['proposal-title', 'proposal-counts', 'proposal-mode', 'compare']) expect(bar.contains(hook(name)), name).toBe(true);
    const options = [...hook('compare').querySelectorAll('[data-corn="compare-option"]')];
    expect(options.map((o) => o.getAttribute('data-view'))).toEqual(['before', 'diff', 'after']);
    expect(options.map((o) => o.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(bar.querySelector('#proposal-edit').getAttribute('data-corn-kind')).toBe('secondary');
    const column = hook('review-column');
    expect(column.querySelector('[data-corn="decision"]').getAttribute('role')).toBe('group');
    expect(column.querySelector('[data-review="notes"]').getAttribute('data-corn-kind')).toBe('secondary');
    expect(column.querySelector('[data-review="approved"]').getAttribute('data-corn-kind')).toBe('approve');
  });

  it('has the Work panel\'s Filter chip and its fields, and the node panel\'s diff pill', () => {
    expect(hook('work-panel').contains(hook('filter-chip'))).toBe(true);
    expect(hook('filter-chip')).toBe(document.getElementById('forge-filter-chip'));
    for (const c of document.querySelectorAll('#forge-filter-box select, #forge-filter-box input')) expect(c.getAttribute('data-corn'), c.id).toBe('control');
    expect(hook('node-panel').contains(hook('diff-pill'))).toBe(true);
    expect(hook('node-panel').contains(hook('node-title'))).toBe(true);
  });

  it('has each panel', () => {
    expect(hook('proposal-bar')).toBe(document.getElementById('proposal-bar'));
    expect(hook('work-panel')).toBe(document.getElementById('forge-panel'));
    // `forge-panel` is the old name of the hook, kept for one release (docs/theming.md): it is on the panel's inner box
    expect(hook('forge-panel')).toBe(document.getElementById('forge-panel').firstElementChild);
    expect(hook('node-panel')).toBe(document.getElementById('spec-drawer'));
    expect(document.getElementById('drawer-badge').getAttribute('data-corn')).toBe('badge');
    expect(hook('mobile-search')).toBe(document.getElementById('mobile-search-bar'));
  });

  it('has the tabs of the issues panel, one hook each', () => {
    const tabs = [...document.querySelectorAll('#forge-panel [data-corn="tab"]')];
    expect(tabs.map((t) => t.getAttribute('data-forge-kind'))).toEqual(['specs', 'pulls', 'issues', 'threads', 'work', 'deploys']);
    expect(hook('tabs').contains(tabs[0])).toBe(true);
  });

  it('has the three dialogs, each in a scrim, and every dialog box ends in -dialog', () => {
    expect(hook('confirm-dialog').closest('[data-corn="dialog-scrim"]').id).toBe('forge-confirm');
    expect(hook('agent-dialog').closest('[data-corn="dialog-scrim"]').id).toBe('agent-start');
    expect(hook('tokens-dialog').closest('[data-corn="dialog-scrim"]').id).toBe('tokens-dialog');
    const boxes = [...document.querySelectorAll('[role="dialog"]')];
    expect(boxes.length).toBe(3);
    for (const b of boxes) expect(b.getAttribute('data-corn')).toMatch(/-dialog$/);
  });

  it('gives each button kind its element', () => {
    expect($('#idea-open').getAttribute('data-corn-kind')).toBe('approve');
    expect($('[data-action="close-proposal"]').getAttribute('data-corn-kind')).toBe('quiet');
    expect($('[data-action="close-drawer"]').getAttribute('data-corn-kind')).toBe('icon');
    expect($('[data-action="retry"]').getAttribute('data-corn-kind')).toBe('primary');
    expect(document.querySelectorAll('[data-corn-kind]').length).toBeGreaterThan(10);
  });
});

describe('markup made by script', () => {
  beforeEach(() => {
    document.body.innerHTML = body;
    ensurePagePieces();
    Object.assign(state, { nodes: [{ id: 'a', type: 'page', x: 100, y: 100, r: 20, color: '#fff', label: 'a' }, { id: 'b', type: 'app', x: 300, y: 100, r: 20, color: '#fff', label: 'b' }], edges: [{ from: 'a', to: 'b', kind: 'calls' }], width: 800, height: 600, camera: { x: 0, y: 0, zoom: 1 }, coveredBottom: 0, scenario: null, proposal: undefined, theme: 'dark', activeLayers: {} });
    state.canvas = document.getElementById('graph-canvas');
    vi.stubGlobal('requestAnimationFrame', () => 0);
    setRenderer({ kind: 'stub', draw() {}, resize() {}, destroy() {} });
  });
  afterEach(() => { clearScenario(); vi.unstubAllGlobals(); });

  it('puts a row hook on each layer row; aria-pressed says which are on', () => {
    renderLayerToggles();
    const rows = [...document.querySelectorAll('[data-corn="layers-menu"] [data-corn="row"]')];
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect(['true', 'false']).toContain(r.getAttribute('aria-pressed'));
  });

  it('puts the hooks on the config\'s links and Sign out', () => {
    applyBranding(document, { links: [{ label: 'Repo', href: 'https://forge.example.test/acme' }], signIn: { login: 'maintainer' } });
    const links = hook('links');
    expect(links.querySelector('a[data-corn="link"]').getAttribute('href')).toBe('https://forge.example.test/acme');
    const out = links.querySelector('[data-corn="sign-out"]');
    expect(out.tagName).toBe('FORM');
    expect(out.querySelector('button').getAttribute('data-corn-kind')).toBe('quiet');
  });

  it('puts hooks on a proposal card in the Proposals menu', () => {
    const host = document.createElement('div');
    host.innerHTML = proposalRowHtml({ slug: '0001-x', source: 'checkout', title: 'Meals', summary: 'Adds meals', counts: { added: 1, changed: 0, removed: 0 } }, { slug: '0001-x', source: 'checkout' });
    const card = host.querySelector('[data-corn="row"]');
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('data-action')).toBe('open-proposal');
  });

  it('puts hooks on a run card: its state, its pill with the same state, its buttons with their kinds', () => {
    const ctx = { esc: escHtml, safeUrl: () => false, forgeName: 'Forge', forgeType: 'github', repoUrl: null, now: Date.parse('2026-10-18T12:00:00Z'), nodes: state.nodes, selected: null, timelines: new Set(), replies: new Map(), busy: false };
    const run = { runId: 'r1', kind: 'spec', status: 'working', open: true, refs: { issue: 5 }, requestedAt: '2026-10-18T11:00:00Z', nodes: ['a'], timeline: [], checks: [] };
    const host = document.createElement('ul');
    host.innerHTML = runsHtml(ctx, [run]);
    const card = host.querySelector('[data-corn="run"]');
    expect(card.getAttribute('data-corn-state')).toBe('working');
    expect(card.querySelector('[data-corn="state-pill"]').getAttribute('data-corn-state')).toBe('working');
    expect(card.querySelector('[data-forge-stop]').getAttribute('data-corn-kind')).toBe('danger');
    host.innerHTML = runsHtml(ctx, [{ ...run, status: 'failed', open: false }, { ...run, runId: 'r2', status: 'requested' }]);
    expect([...host.querySelectorAll('[data-corn="run"]')].map((r) => r.getAttribute('data-corn-state')).sort()).toEqual(['failed', 'requested']);
  });

  it('maps every internal word onto the documented states, and nothing else', () => {
    const words = ['open', 'merged', 'closed', 'draft', 'requested', 'claimed', 'working', 'waiting', 'quiet', 'done', 'failed', 'stopped', 'stop-requested',
      'success', 'failure', 'running', 'queued', 'neutral', 'skipped', 'cancelled', 'approved', 'unreviewed', 'changed', 'missing', 'allowed', 'refused', 'mismatch', 'pending', 'ok', 'bad'];
    for (const w of words) expect(states, w).toContain(cornState(w));
    expect(cornState('failed')).toBe('failed'); // a run
    expect(cornState('failure')).toBe('failure'); // a result
    expect(cornState('unchecked')).toBe('');
    expect(cornState('<script>')).toBe('');
  });

  it('puts hooks on the mockups section of the node panel', () => {
    const host = document.createElement('div');
    host.innerHTML = mockupsSectionHtml([{ index: 0, node: 'a', path: 'x.png', title: 'List', type: 'image', url: '/m/0', state: 'changed' }]);
    expect(host.querySelector('[data-corn="section"] [data-corn="row"] [data-mockup]').getAttribute('data-mockup')).toBe('0');
    expect(host.querySelector('[data-corn="state-pill"]').getAttribute('data-corn-state')).toBe('waiting');
  });

  it('puts hooks on the scenario player', () => {
    initScenarioUi();
    playScenario({ id: 's', title: 'Saving', stepMs: 1000, steps: [{ node: 'a', text: 'Opens.' }, { node: 'b', text: 'Saves.' }] }, { autoplay: false });
    const bar = hook('scenario-player');
    expect(bar).not.toBeNull();
    expect(bar.querySelector('[data-action="scenario-toggle"]').getAttribute('data-corn-kind')).toBe('primary');
    expect(bar.querySelector('[data-action="scenario-close"]').getAttribute('data-corn-kind')).toBe('icon');
    expect(bar.querySelector('[data-corn="sheet-handle"]')).not.toBeNull(); // the bottom-sheet handle the player is given
  });
});
