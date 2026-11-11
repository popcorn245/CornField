/**
 * @vitest-environment node
 *
 * `strings` (core/strings.js, docs/theming.md "Words"): the one table of overridable labels, what the config check says about a value,
 * what the browser is sent, and that the docs' table is the generated one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STRINGS, MAX_STRING_LENGTH, stringsProblems, stringProblem, clientStrings, stringsTable, isStringKey } from '../../core/strings.js';
import { configProblems, loadConfig } from '../../core/config.js';
import { clientConfig, BROWSER_CORE } from '../../server/server.js';
import { CORNFIELD } from '../helpers.js';

describe('the table', () => {
  it('is a short list of plain one-line words, camelCase keys', () => {
    const keys = Object.keys(STRINGS);
    expect(keys.length).toBeGreaterThanOrEqual(30);
    expect(keys.length).toBeLessThanOrEqual(90);
    for (const [k, v] of Object.entries(STRINGS)) {
      expect(k).toMatch(/^[a-z][A-Za-z]*$/);
      expect(stringProblem(v), `${k} default`).toBeNull();
    }
  });

  it('is served to the browser', () => {
    expect(BROWSER_CORE).toContain('strings.js');
  });

  it('knows only its own keys', () => {
    expect(isStringKey('approve')).toBe(true);
    for (const k of ['__proto__', 'toString', 'constructor', 'nope', 7]) expect(isStringKey(k)).toBe(false);
  });
});

describe('the docs', () => {
  it('hold exactly the generated table (regenerate it with stringsTable())', () => {
    const docs = fs.readFileSync(path.join(CORNFIELD, 'docs', 'theming.md'), 'utf8');
    const m = /<!-- strings:start -->\n([\s\S]*?)\n<!-- strings:end -->/.exec(docs);
    expect(m, 'docs/theming.md "Words" has the strings:start and strings:end markers').not.toBeNull();
    expect(m[1]).toBe(stringsTable());
  });
});

describe('a strings value in the config', () => {
  it('accepts known keys with plain text, and none at all', () => {
    expect(configProblems({})).toEqual([]);
    expect(configProblems({ strings: {} })).toEqual([]);
    expect(configProblems({ strings: { approve: 'Ship it', sendBack: 'Not yet' } })).toEqual([]);
  });

  it('refuses an unknown key, naming it and the known ones', () => {
    const [p, ...rest] = configProblems({ strings: { approvee: 'Ship it' } });
    expect(rest).toEqual([]);
    expect(p).toContain('unknown key "approvee"');
    for (const k of Object.keys(STRINGS)) expect(p).toContain(k);
    expect(configProblems({ strings: { __proto__x: 'a', toString: 'a' } }).join('\n')).toContain('"toString"');
  });

  it('refuses a value that is not text, is empty, is too long or has a line break', () => {
    const one = (v) => configProblems({ strings: { approve: v } });
    for (const v of [5, null, true, ['a'], { a: 1 }]) expect(one(v)[0], String(v)).toBe('strings.approve is text.');
    expect(one('')[0]).toMatch(/strings\.approve is empty/);
    expect(one('   ')[0]).toMatch(/is empty/);
    expect(one('a\nb')[0]).toMatch(/one line/);
    expect(one('a\r\nb')[0]).toMatch(/one line/);
    expect(one('a b')[0]).toMatch(/one line/);
    expect(one('a\tb')[0]).toMatch(/one line/);
    expect(one('x'.repeat(MAX_STRING_LENGTH))).toEqual([]);
    expect(one('x'.repeat(MAX_STRING_LENGTH + 1))[0]).toBe(`strings.approve is at most ${MAX_STRING_LENGTH} characters.`);
  });

  it('refuses a strings that is not an object', () => {
    for (const v of ['Ship it', ['approve'], 3, null]) expect(configProblems({ strings: v })[0]).toMatch(/"strings" is an object/);
  });

  it('keeps HTML as the text it is (nothing to refuse: it is only ever shown as characters)', () => {
    const html = '<img src=x onerror=alert(1)> & "q"';
    expect(configProblems({ strings: { approve: html } })).toEqual([]);
    expect(clientStrings({ approve: html })).toEqual({ approve: html });
  });
});

describe('what the browser is sent', () => {
  it('is the overridden keys only, and never a bad one', () => {
    expect(clientStrings({})).toEqual({});
    expect(clientStrings(undefined)).toEqual({});
    expect(clientStrings({ approve: 'Ship it', nope: 'x', sendBack: 4, stop: 'a\nb' })).toEqual({ approve: 'Ship it' });
    expect(stringsProblems(undefined)).toEqual([]);
    const proto = JSON.parse('{"__proto__": "x", "constructor": "y", "approve": "Ship it"}');
    expect(stringsProblems(proto).join('\n')).toMatch(/unknown key "__proto__"[\s\S]*unknown key "constructor"/);
    const sent = clientStrings(proto);
    expect(sent).toEqual({ approve: 'Ship it' });
    expect(Object.getPrototypeOf(sent)).toBe(Object.prototype);
  });

  it('comes in /cornfield/config.json as `strings`', () => {
    expect(clientConfig({ title: 't', sources: {}, strings: { approve: 'Ship it', bogus: 'x' } }).strings).toEqual({ approve: 'Ship it' });
    expect(clientConfig({ title: 't', sources: {} }).strings).toEqual({});
  });
});

describe('loading a config', () => {
  const made = [];
  afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });
  const repo = (text) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-strings-'));
    made.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
    fs.writeFileSync(path.join(root, 'cornfield.config.js'), text);
    return root;
  };

  it('defaults to no overrides and carries the file\'s', async () => {
    expect((await loadConfig(repo('export default {};'))).strings).toEqual({});
    expect((await loadConfig(repo("export default { strings: { approve: 'Ship it' } };"))).strings).toEqual({ approve: 'Ship it' });
  });

  it('fails on an unknown key, naming it', async () => {
    await expect(loadConfig(repo("export default { strings: { aprove: 'x' } };"))).rejects.toThrow(/unknown key "aprove"/);
  });
});
