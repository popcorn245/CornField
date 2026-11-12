/**
 * @vitest-environment node
 *
 * `embed.origins` in the config (core/config.js `embedOrigin`, `configProblems`, `loadConfig`): exact origins only, https unless the host is this
 * machine's own, said in words, normalised so the same origin written two ways is one entry. Off by default: no key is no origin.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { configProblems, embedOrigin, loadConfig, DEFAULTS, MAX_EMBED_ORIGINS } from '../../core/config.js';

const problems = (origins) => configProblems({ embed: { origins } });

describe('embed.origins', () => {
  it('is empty by default and absent from a config that does not name it', async () => {
    expect(DEFAULTS.embed).toEqual({ origins: [] });
    expect(configProblems({})).toEqual([]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-embed-cfg-'));
    try {
      expect((await loadConfig(dir, { env: { CORNFIELD_DATA: dir } })).embed).toEqual({ origins: [] });
      fs.writeFileSync(path.join(dir, 'cornfield.config.mjs'), 'export default { embed: { origins: ["HTTPS://Tasks.Example.com:443", "http://localhost:5173", "https://map.example.com:8443"] } };');
      expect((await loadConfig(dir, { env: { CORNFIELD_DATA: dir } })).embed.origins).toEqual(['https://tasks.example.com', 'http://localhost:5173', 'https://map.example.com:8443']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('takes exact https origins, and http for this machine\'s own names only', () => {
    for (const ok of ['https://tasks.example.com', 'https://tasks.example.com:8443', 'https://a.b.c.example.org', 'https://intranet', 'https://[2001:db8::1]:8443',
      'http://localhost', 'http://localhost:5173', 'http://tasks.corn.localhost:3711', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://localhost:5173']) {
      expect(problems([ok]), ok).toEqual([]);
    }
  });

  it('writes each origin one way: scheme and host in lower case, a default port dropped', () => {
    expect(embedOrigin('HTTPS://TASKS.Example.COM')).toEqual({ origin: 'https://tasks.example.com' });
    expect(embedOrigin('https://tasks.example.com:443')).toEqual({ origin: 'https://tasks.example.com' });
    expect(embedOrigin('http://localhost:80')).toEqual({ origin: 'http://localhost' });
    expect(problems(['https://tasks.example.com', 'HTTPS://tasks.example.com:443'])).toEqual(['embed.origins[1] "HTTPS://tasks.example.com:443" is listed twice.']);
  });

  it('says in words what is wrong', () => {
    const say = (v) => problems([v]).join('\n');
    expect(say('https://*.example.com')).toMatch(/wildcard: list each origin exactly/);
    expect(say('*')).toMatch(/wildcard/);
    expect(say('https://tasks.example.com/')).toMatch(/path, query or fragment \(a trailing slash counts\)/);
    expect(say('https://tasks.example.com/app')).toMatch(/path, query or fragment/);
    expect(say('https://tasks.example.com?x=1')).toMatch(/path, query or fragment/);
    expect(say('https://tasks.example.com#x')).toMatch(/path, query or fragment/);
    expect(say('tasks.example.com')).toMatch(/no https:\/\/ in front/);
    expect(say('//tasks.example.com')).toMatch(/no https:\/\/ in front/);
    expect(say('ftp://tasks.example.com')).toMatch(/no https:\/\/ in front/);
    expect(say('http://tasks.example.com')).toMatch(/plain http: only https, or http for localhost/);
    expect(say('http://127.0.0.2')).toMatch(/plain http/);
    expect(say('http://localhost.evil.test')).toMatch(/plain http/);
    expect(say('https://user@tasks.example.com')).toMatch(/user name/);
    expect(say('https://tasks.example.com\\@evil.test')).toMatch(/backslash/);
    expect(say('https://tasks.example.com:0')).toMatch(/port/);
    expect(say('https://tasks.example.com:99999')).toMatch(/port/);
    expect(say('https://tasks.example.com:080')).toMatch(/port/);
    expect(say('https://2130706433')).toMatch(/would be read as/);
    expect(say('https://0x7f.1')).toMatch(/would be read as/);
    expect(say('https://tasks.example.com.')).toMatch(/not an origin/);
    expect(say('https://tasks example.com')).toMatch(/no spaces/);
    expect(say('')).toMatch(/is an origin like https:\/\/tasks.example.com/);
    expect(say(42)).toMatch(/is an origin like/);
    expect(say(null)).toMatch(/is an origin like/);
    expect(say('https://tasks.example.com')).toBe('');
  });

  it('checks the shape of the key', () => {
    expect(configProblems({ embed: 'https://tasks.example.com' })).toEqual(['"embed" is { origins: ["https://tasks.example.com"] }.']);
    expect(configProblems({ embed: [] })).toEqual(['"embed" is { origins: ["https://tasks.example.com"] }.']);
    expect(configProblems({ embed: { origins: 'https://tasks.example.com' } })).toEqual(['embed.origins is a list of origins, like ["https://tasks.example.com"].']);
    expect(configProblems({ embed: { origin: ['https://tasks.example.com'] } })).toEqual(['embed.origin: the only key is origins.']);
    expect(configProblems({ embed: {} })).toEqual([]);
    expect(configProblems({ embed: null })).toEqual([]);
    expect(problems(Array.from({ length: MAX_EMBED_ORIGINS + 1 }, (_, i) => `https://a${i}.example.com`))[0]).toMatch(/at most 20/);
  });

  it('names the entry that is wrong, so `cornfield validate` can say which', async () => {
    expect(problems(['https://tasks.example.com', 'http://tasks.example.com'])).toEqual([expect.stringMatching(/^embed\.origins\[1\] "http:\/\/tasks\.example\.com" is plain http/)]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-embed-cfg-'));
    try {
      fs.writeFileSync(path.join(dir, 'cornfield.config.mjs'), 'export default { embed: { origins: ["https://*.example.com"] } };');
      await expect(loadConfig(dir, { env: { CORNFIELD_DATA: dir } })).rejects.toThrow(/embed\.origins\[0\] "https:\/\/\*\.example\.com" has a wildcard/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
