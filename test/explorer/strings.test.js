// @vitest-environment happy-dom
/**
 * Words in the page (explorer/strings.js, docs/theming.md "Words"): `t()` falls back to the table, the static markup
 * is replaced where it is marked, the generated markup reads the overrides, a control's accessible name follows its
 * visible label, a value is only ever text, and the page passes axe with overrides in both themes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
import { STRINGS } from '../../core/strings.js';
import { explorerPage } from '../helpers.js';
// @ts-expect-error plain JS modules, no declarations
import { t, setStrings, applyStrings, resetStringsForTests } from '../../explorer/strings.js';
// @ts-expect-error plain JS modules, no declarations
import { applyBranding } from '../../explorer/plugins.js';
// @ts-expect-error plain JS modules, no declarations
import { runsHtml } from '../../explorer/runs-view.js';
// @ts-expect-error plain JS modules, no declarations
import { syncViewUi } from '../../explorer/view.js';
// @ts-expect-error plain JS modules, no declarations
import { state, escHtml } from '../../explorer/state.js';
// @ts-expect-error plain JS modules, no declarations
import { initReview, resetReviewForTests } from '../../explorer/review.js';

import { explorerCss } from './stylesheets.js';
const EXPLORER = path.resolve(__dirname, '../../explorer');
const page = explorerPage({ pieces: true }); // the pieces' markup in its places
const body = /<body>([\s\S]*)<\/body>/.exec(page)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const css = explorerCss(['tokens.css', 'explorer.css', 'house.css']);
const $ = (id) => document.getElementById(id);

/** Every key, overridden with a marker word (the key itself, so a test can tell which key a label came from) */
const ALL = Object.fromEntries(Object.keys(STRINGS).map((k) => [k, `«${k}»`]));

beforeEach(() => { resetStringsForTests(); document.head.innerHTML = `<title>x</title><style>${css}</style>`; document.documentElement.lang = 'en'; document.body.innerHTML = body; });
afterEach(() => { vi.unstubAllGlobals(); resetStringsForTests(); resetReviewForTests(); delete document.documentElement.dataset.theme; document.body.innerHTML = ''; });

describe('t', () => {
  it('gives the default, and the override once set', () => {
    expect(t('approve')).toBe('Approve');
    setStrings({ approve: 'Ship it' });
    expect(t('approve')).toBe('Ship it');
    expect(t('sendBack')).toBe('Send back');
  });

  it('ignores an unknown key, a non-string, a long or multi-line value, and starts over on the next call', () => {
    setStrings({ approve: 'Ship it', nope: 'x', sendBack: 4, stop: 'a\nb', reply: 'x'.repeat(81), __proto__: { diff: 'z' } });
    expect(t('approve')).toBe('Ship it');
    expect(t('sendBack')).toBe('Send back');
    expect(t('stop')).toBe('Stop');
    expect(t('reply')).toBe('Reply');
    expect(t('diff')).toBe('Diff');
    expect(t('nope')).toBe('nope');
    setStrings(undefined);
    expect(t('approve')).toBe('Approve');
    setStrings(['approve']);
    expect(t('approve')).toBe('Approve');
  });

  it('takes no prototype key, as JSON (the config as the browser gets it) can hold one', () => {
    setStrings(JSON.parse('{"__proto__": {"approve": "x"}, "constructor": "y", "hasOwnProperty": "z", "stop": "Halt"}'));
    expect(t('approve')).toBe('Approve');
    expect(t('stop')).toBe('Halt');
    expect(t('constructor')).toBe('constructor');
    expect(Object.prototype).not.toHaveProperty('approve');
  });
});

describe('the static markup', () => {
  it('is left alone without overrides', () => {
    const before = document.body.innerHTML;
    applyStrings(document);
    expect(document.body.innerHTML).toBe(before);
  });

  it('every marked element names a key of the table and holds only its default text', () => {
    const marked = [...document.querySelectorAll('[data-corn-string],[data-corn-string-aria-label],[data-corn-string-placeholder]')]
      .flatMap((el) => [el.getAttribute('data-corn-string'), el.getAttribute('data-corn-string-aria-label'), el.getAttribute('data-corn-string-placeholder')]).filter(Boolean);
    for (const k of marked) expect(Object.keys(STRINGS), k).toContain(k);
    // The text of a marked element is the default, so the page reads right before (and without) the config
    // and its text only: applyStrings sets textContent, which would wipe an icon or any other child element
    for (const el of document.querySelectorAll('[data-corn-string]')) {
      expect(el.textContent.trim().replace(/\s+/g, ' '), el.outerHTML).toBe(STRINGS[el.getAttribute('data-corn-string')]);
      expect(el.children.length, el.outerHTML).toBe(0);
    }
  });

  it('is replaced where it is marked: text, aria-label and placeholder', () => {
    applyBranding(document, { title: 'x', links: [], signIn: false, strings: ALL });
    expect($('legend-toggle-btn').textContent).toContain('«layers»'); // its name is its text
    expect($('preset-dataflow-btn').textContent).toContain('«dataFlow»');
    expect($('forge-btn').getAttribute('aria-label')).toBe('«issuesAndPrs»');
    expect($('node-search').getAttribute('placeholder')).toBe('«searchPlaceholder»');
    expect(document.querySelector('[data-view="diff"]').textContent).toBe('«diff»');
    expect(document.querySelector('[data-forge-kind="pulls"]').textContent).toBe('«tabPulls»');
    expect(document.querySelector('[data-forge-kind="specs"]').textContent).toBe('«tabSpecs»');
    expect(document.querySelector('[data-forge-kind="work"]').textContent).toBe('«tabRuns»');
    expect($('idea-open').textContent).toBe('«newIdea» …');
    expect($('loading-state').textContent).toBe('«loading»');
    expect($('error-state').querySelector('strong').textContent).toBe('«errorTitle»');
    expect($('agent-start-title').textContent).toBe('«startAgent»');
  });

  it('one key changes only its own element', () => {
    applyBranding(document, { title: 'x', links: [], signIn: false, strings: { tabIssues: 'Tickets' } });
    expect(document.querySelector('[data-forge-kind="issues"]').textContent).toBe('Tickets');
    expect(document.querySelector('[data-forge-kind="pulls"]').textContent).toBe('PRs');
  });

  it('is text: HTML in a value shows as characters and makes no element', () => {
    const evil = '<img src=x onerror=alert(1)>"\'';
    applyBranding(document, { title: 'x', links: [], signIn: false, strings: { layers: evil, searchPlaceholder: evil, signOut: evil, poweredBy: evil }, brand: { poweredBy: 'https://example.test/' } });
    expect($('legend-toggle-btn').querySelector('img')).toBeNull();
    expect($('node-search').getAttribute('placeholder')).toBe(evil);
    expect(document.querySelector('[data-corn="powered-by"]').textContent).toBe(evil);
    expect(document.querySelectorAll('img[onerror]').length).toBe(0);
  });

  it('the built header reads the words: Sign out and powered by', () => {
    applyBranding(document, { title: 'x', links: [], signIn: { login: 'm' }, brand: { poweredBy: 'https://example.test/' }, strings: { signOut: 'Leave', poweredBy: 'made with corn' } });
    expect(document.querySelector('[data-corn="sign-out"] button').textContent).toBe('Leave');
    expect(document.querySelector('[data-corn="powered-by"]').textContent).toBe('made with corn');
    applyBranding(document, { title: 'x', links: [], signIn: { login: 'm' }, brand: { poweredBy: 'https://example.test/' } });
    expect(document.querySelector('[data-corn="sign-out"] button').textContent).toBe('Sign out');
    expect(document.querySelector('[data-corn="powered-by"]').textContent).toBe('powered by cornfield');
  });
});

describe('the generated markup', () => {
  it('the hint follows the view', () => {
    setStrings({ hintInspect: 'Poke a node', hintDrag: 'Drag it', hintDataFlow: 'Follow the data' });
    Object.assign(state, { view: 'orbit', isFreeform: false });
    syncViewUi();
    expect($('instruction-badge-text').textContent).toBe('Poke a node');
    state.isFreeform = true;
    syncViewUi();
    expect($('instruction-badge-text').textContent).toBe('Drag it');
    state.view = 'dataflow';
    syncViewUi();
    expect($('instruction-badge-text').textContent).toBe('Follow the data');
    state.view = 'orbit';
    state.isFreeform = false;
  });

  it('the review bar reads the words, as text', () => {
    setStrings({ approve: 'Ship it', sendBack: 'Not yet', sendBackWithNote: 'Not yet, because', reviewNoteLabel: 'Tell the bot', reviewNotePlaceholder: '<b>why?</b>' });
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }));
    state.proposal = { title: 'p' };
    state.proposalSlug = 's';
    state.proposalSource = 'pull/3';
    initReview();
    const root = $('review');
    const bar = $('review-decision');
    expect(bar.querySelector('[data-review="approved"]').textContent).toBe('Ship it');
    expect(bar.querySelector('[data-review="notes"]').textContent).toBe('Not yet');
    expect(root.querySelector('label').textContent).toBe('Tell the bot');
    expect($('review-note').getAttribute('placeholder')).toBe('<b>why?</b>');
    state.proposal = null;
  });
});

describe('accessible names follow the visible label', () => {
  const ctx = { esc: escHtml, safeUrl: (u) => u, forgeName: 'GitHub', forgeType: 'github', repoUrl: null, nodes: [], selected: null, now: 0, busy: false, replies: new Map(), timelines: new Set() };
  const run = (extra = {}) => ({ runId: 'r7', kind: 'code', profile: null, refs: { issue: 9 }, status: 'waiting', open: true, requestedBy: 'm', requestedAt: '2026-11-05T11:00:00Z', via: 'dashboard', comment: null, limits: {}, stopRequested: null, checks: null, answer: null, report: null, pull: null, ...extra });
  const buttons = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return [...d.querySelectorAll('button')];
  };

  it('a button whose name adds a target keeps the target and takes the label', () => {
    setStrings({ stop: 'Halt', continueRun: 'Carry on', reply: 'Answer', startAgain: 'Go again' });
    const html = runsHtml(ctx, [run({ status: 'failed', open: false })], []);
    const stop = buttons(runsHtml(ctx, [run()], []));
    const pairs = [...stop, ...buttons(html)].map((b) => [b.textContent.trim(), b.getAttribute('aria-label')]).filter(([, a]) => a);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [text, aria] of pairs) if (['Halt', 'Carry on', 'Answer', 'Go again'].includes(text)) expect(aria.startsWith(text), `${text} / ${aria}`).toBe(true);
    // the label first, then what the run is called (what its card shows, never its id)
    for (const label of ['Halt', 'Answer', 'Carry on']) expect(pairs.some(([t2, a]) => t2 === label && a.startsWith(`${label}: `) && !a.includes('r7')), label).toBe(true);
  });

  it('every labelled control whose name is its label carries the same words after an override', () => {
    applyBranding(document, { title: 'x', links: [], signIn: false, strings: ALL });
    for (const el of document.querySelectorAll('[data-corn-string-aria-label]')) {
      const key = el.getAttribute('data-corn-string-aria-label');
      expect(el.getAttribute('aria-label'), key).toBe(`«${key}»`);
      const visible = el.querySelector('[data-corn-string]');
      if (visible) expect(visible.textContent, key).toBe(el.getAttribute('aria-label'));
    }
  });

  it('with no override the names are the defaults, as before', () => {
    expect($('legend-toggle-btn').textContent).toContain('Layers'); // its name is its text
    const html = runsHtml(ctx, [run()], []);
    expect(buttons(html).map((b) => b.getAttribute('aria-label')).some((a) => a && a.startsWith('Stop: '))).toBe(true);
  });
});

describe('the code only asks for keys the table has', () => {
  it('every t(\'key\') in the explorer is a key, and every key is asked for or marked in the page', () => {
    const files = ['.', 'engine', 'pieces'].flatMap((d) => fs.readdirSync(path.join(EXPLORER, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
    const asked = new Set();
    for (const f of files) for (const m of fs.readFileSync(path.join(EXPLORER, f), 'utf8').matchAll(/\bt\((?:inst, )?'([A-Za-z]+)'\)/g)) asked.add(m[1]); // the pieces read their words with t(inst, 'key')
    expect(asked.size).toBeGreaterThan(10);
    for (const k of asked) expect(Object.keys(STRINGS), k).toContain(k);
    for (const m of page.matchAll(/data-corn-string(?:-aria-label|-placeholder)?="([A-Za-z]+)"/g)) asked.add(m[1]);
    for (const k of Object.keys(STRINGS)) expect(asked.has(k), `${k} is in the table but nothing shows it`).toBe(true);
  });
});

describe('axe with overrides', () => {
  const audit = async () => {
    const r = await axe.run({ include: [document.documentElement], exclude: [['iframe']] }, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false } } });
    return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
  };
  const long = Object.fromEntries(Object.keys(STRINGS).map((k) => [k, `Brand ${k} `.padEnd(60, 'x').trim()]));
  for (const theme of ['dark', 'light']) {
    it(`finds no violation on the page with every label overridden (${theme})`, async () => {
      if (theme === 'light') document.documentElement.dataset.theme = 'light';
      applyBranding(document, { title: 'Acme', links: [], signIn: { login: 'm' }, brand: { poweredBy: 'https://example.test/' }, strings: long });
      expect(await audit()).toEqual([]);
    });
  }
});
