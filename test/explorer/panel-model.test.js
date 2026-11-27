import { describe, it, expect } from 'vitest';
import { actionBarHtml, nextHtml, sectionHtml, groupLinks, relTitle, readPrefs, isOpen, withOpen, panelKind, BESIDE } from '../../explorer/panel-model.js';

const btn = (name) => `<button type="button">${name}</button>`;

describe('the action bar (spec 0015 D4)', () => {
  it('puts the primary action first, two beside it, and the rest under ⋯', () => {
    const out = actionBarHtml({ primary: btn('Review'), others: [btn('Land it'), btn('Start an agent'), btn('Open on the forge')] });
    expect(BESIDE).toBe(2);
    expect(out).toMatch(/data-corn="actions" role="group" aria-label="Actions"/);
    const row = out.slice(0, out.indexOf('data-more-menu'));
    expect(row.indexOf('Review')).toBeLessThan(row.indexOf('Land it'));
    expect(row.indexOf('Land it')).toBeLessThan(row.indexOf('Start an agent'));
    expect(row).not.toContain('Open on the forge');
    expect(out).toMatch(/data-corn="more" data-corn-kind="quiet" data-more-toggle aria-expanded="false" aria-label="More actions"/);
    expect(out).toMatch(/data-more-menu role="group" aria-label="More actions" hidden>.*Open on the forge/);
  });
  it('has no ⋯ when everything fits, and leads with the first other when there is no primary', () => {
    const out = actionBarHtml({ others: [btn('Open'), '', btn('Start a spec')] });
    expect(out).not.toContain('data-more-toggle');
    expect(out.indexOf('Open')).toBeLessThan(out.indexOf('Start a spec'));
  });
  it('says what comes next in one line, and is nothing when there is nothing', () => {
    expect(actionBarHtml({ primary: btn('Land it'), next: 'Then: Land it once docs finishes.' })).toContain('<p class="hx-next">Then: Land it once docs finishes.</p>');
    expect(actionBarHtml({ next: 'Closed.' })).toContain('hx-next');
    expect(actionBarHtml({})).toBe('');
    expect(nextHtml('<b>')).toBe('<p class="hx-next">&lt;b&gt;</p>');
    expect(nextHtml('')).toBe('');
  });
});

describe('a section (spec 0015 D4)', () => {
  it('is closed unless it holds the action, with its count on its toggle', () => {
    const shut = sectionHtml({ key: 'files', title: 'Files', count: 3, body: '<ul></ul>' });
    expect(shut).toMatch(/data-corn="section" data-sec="files"/);
    expect(shut).toMatch(/data-sec-toggle="files" data-sec-default="false" aria-expanded="false"/);
    expect(shut).toContain('<span class="hx-sec-count" data-corn="count">3</span>');
    expect(shut).toContain('<div class="hx-sec-body" hidden>');
    const open = sectionHtml({ key: 'checks', title: 'Checks', count: 2, note: '1 failed', body: 'x', open: true });
    expect(open).toMatch(/aria-expanded="true"/);
    expect(open).toContain('<div class="hx-sec-body">x</div>');
    expect(open).toContain('1 failed');
    expect(sectionHtml({ key: 'a', title: '<i>', body: '' })).not.toContain('<i>');
  });
});

describe('Connected, grouped by relation', () => {
  it('groups rows by their words, in the order first seen', () => {
    const g = groupLinks([{ rel: 'adds', id: 1 }, { rel: 'closes', id: 2 }, { rel: 'adds', id: 3 }]);
    expect(g.map((x) => [x.rel, x.rows.length])).toEqual([['adds', 2], ['closes', 1]]);
    expect(groupLinks(null)).toEqual([]);
    expect(relTitle('discussed in')).toBe('Discussed in');
  });
});

describe('what the browser remembers of open sections, per kind of node', () => {
  it('reads what was stored, and nothing from a broken value', () => {
    expect(readPrefs('{"pull":{"files":true}}')).toEqual({ pull: { files: true } });
    expect(readPrefs('not json')).toEqual({});
    expect(readPrefs('[1]')).toEqual({});
    expect(readPrefs(null)).toEqual({});
  });
  it('answers open or closed for a kind, else the default, and remembers without changing the old', () => {
    const prefs = { pull: { files: true } };
    expect(isOpen(prefs, 'pull', 'files', false)).toBe(true);
    expect(isOpen(prefs, 'proposal', 'files', false)).toBe(false);
    expect(isOpen(prefs, 'pull', 'checks', true)).toBe(true);
    const next = withOpen(prefs, 'pull', 'checks', false);
    expect(next).toEqual({ pull: { files: true, checks: false } });
    expect(prefs).toEqual({ pull: { files: true } });
    expect(isOpen({ __proto__: { pull: { files: true } } }, 'pull', 'files', false)).toBe(false);
  });
  it('keeps a piece of work by its kind, and a node of code by its type', () => {
    expect(panelKind({ work: 'pull', type: 'pull' })).toBe('pull');
    expect(panelKind({ type: 'service' })).toBe('service');
    expect(panelKind(null)).toBe('node');
  });
});
