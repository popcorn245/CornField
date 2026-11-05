/**
 * @vitest-environment node
 *
 * cornfield.config.js: what a repo may say, the defaults, env vars over the file, the derivers and the
 * browser sources it names.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { configProblems, loadConfig, loadDerivers, browserSources, DEFAULTS, HOOK_EVENTS, parseDuration, specPollMs } from '../../core/config.js';
import { CORNFIELD, SAMPLE } from '../helpers.js';

const made = [];
const repo = (configText) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-config-'));
  made.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  if (configText !== undefined) fs.writeFileSync(path.join(root, 'cornfield.config.js'), configText);
  return root;
};
afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

describe('configProblems', () => {
  it('accepts an empty config and the sample repo\'s', async () => {
    expect(configProblems({})).toEqual([]);
    const mod = await import(pathToFileURL(path.join(SAMPLE, 'cornfield.config.js')).href);
    expect(configProblems(mod.default)).toEqual([]);
  });

  it('takes a forge\'s merge method: merge, squash or rebase, and nothing else', () => {
    const forge = (mergeMethod) => ({ forge: { type: 'github', repo: 'o/n', mergeMethod } });
    for (const m of [undefined, 'merge', 'squash', 'rebase']) expect(configProblems(forge(m)), m).toEqual([]);
    for (const m of ['force', 'fast-forward', '', 1]) expect(configProblems(forge(m))).toEqual(['forge.mergeMethod is one of merge, squash, rebase.']);
  });

  it('takes a forge\'s base branch for specs: a plain branch name, nothing that could be a path out or an option', () => {
    const forge = (baseBranch) => ({ forge: { type: 'github', repo: 'o/n', baseBranch } });
    for (const b of [undefined, 'main', 'release/1.x', 'v1.0_rc']) expect(configProblems(forge(b)), b).toEqual([]);
    for (const b of ['', '-x', '../x', 'a..b', '/main', 'a b', 'main/', 1, null]) expect(configProblems(forge(b)), String(b)).toEqual(['forge.baseBranch is the branch spec pull requests go into, like "main".']);
  });

  describe('hooks', () => {
    const hooks = (...list) => ({ hooks: list });
    const url = (u) => hooks({ url: u, events: '*' });

    it('takes { url, events } with events from the five names, or "*"', () => {
      expect(HOOK_EVENTS).toEqual(['spec.ready', 'spec.approved', 'spec.sentBack', 'build.opened', 'pr.landed', 'session.expiring', 'thread.opened', 'thread.message', 'thread.linked', 'agent.requested', 'run.claimed', 'run.state', 'run.stopRequested', 'run.finished']);
      expect(configProblems({ hooks: [] })).toEqual([]);
      expect(configProblems(hooks({ url: 'https://chat.example.org/h?x=1', events: ['spec.ready', 'pr.landed'] }, { url: 'https://b.example.org', events: '*' }))).toEqual([]);
      expect(configProblems(hooks({ url: 'https://a.example.org', events: [...HOOK_EVENTS] }))).toEqual([]);
    });

    it('takes http only for the machine itself', () => {
      for (const u of ['http://localhost:9000/x', 'http://127.0.0.1:9000', 'http://127.1.2.3/x', 'http://[::1]:9000/x']) expect(configProblems(url(u)), u).toEqual([]);
      for (const u of ['http://chat.example.org/x', 'http://127.0.0.1.evil.example/x', 'http://10.0.0.5/x', 'http://localhost.evil.example/x']) expect(configProblems(url(u)).join(), u).toMatch(/hooks\[0\]\.url is https/);
    });

    it('refuses anything else as a url: other schemes, no url, text that is no URL, a login in it, a fragment', () => {
      for (const u of ['ftp://x.example.org', 'file:///etc/passwd', 'javascript:alert(1)', 'chat.example.org/hook', '', undefined, null, 5, ['https://a.example.org']]) {
        expect(configProblems(url(u)).length, String(u)).toBeGreaterThan(0);
      }
      expect(configProblems(url('https://user:pass@chat.example.org/x'))[0]).toMatch(/user name or password/);
      expect(configProblems(url('https://chat.example.org/x#frag'))[0]).toMatch(/fragment/);
    });

    it('refuses events that are empty, unknown, repeated, or not a list (and "*" inside a list)', () => {
      const ev = (events) => configProblems(hooks({ url: 'https://a.example.org', events }));
      for (const events of [[], 'spec.ready', undefined, null, 'all', 5, {}]) expect(ev(events)[0], JSON.stringify(events)).toMatch(/events is "\*" or a non-empty list/);
      expect(ev(['spec.ready', 'spec.merged'])).toEqual([expect.stringMatching(/"spec\.merged" is not an event/)]);
      expect(ev(['*'])).toEqual([expect.stringMatching(/"\*" is not an event/)]);
      expect(ev(['pr.landed', 'pr.landed'])[0]).toMatch(/twice/);
    });

    it('refuses a hook that is not an object, a key it does not have (a secret does not go in the file), and a list that is too long or not a list', () => {
      expect(configProblems({ hooks: 'https://a.example.org' })).toEqual(['"hooks" is a list of { url, events }.']);
      expect(configProblems({ hooks: ['https://a.example.org'] })).toEqual(['hooks[0] is { url, events }.']);
      expect(configProblems(hooks({ url: 'https://a.example.org', events: '*', secret: 'x'.repeat(40) }))[0]).toMatch(/hooks\[0\]\.secret: the keys are url, events.*CORNFIELD_HOOK_SECRET/);
      expect(configProblems({ hooks: Array.from({ length: 21 }, () => ({ url: 'https://a.example.org', events: '*' })) })[0]).toMatch(/at most 20/);
    });

    it('defaults to no hooks, and loads the ones the file lists', async () => {
      expect(DEFAULTS.hooks).toEqual([]);
      const root = repo('export default { hooks: [{ url: "https://a.example.org/h", events: ["pr.landed"] }] };');
      expect((await loadConfig(root, { env: {} })).hooks).toEqual([{ url: 'https://a.example.org/h', events: ['pr.landed'] }]);
      expect((await loadConfig(repo('export default {};'), { env: {} })).hooks).toEqual([]);
      await expect(loadConfig(repo('export default { hooks: [{ url: "http://a.example.org", events: "*" }] };'), { env: {} })).rejects.toThrow(/hooks\[0\]\.url is https/);
    });
  });

  it('names what is wrong: unknown keys, a bad port, a deriver or source that is neither built in nor a path, a path out of the repo', () => {
    const out = configProblems({
      colour: 'red', port: 70000, derivers: ['nope', './../x.js', { use: 'starter', options: 3 }],
      sources: { live: 'mystery', radio: null, house: { use: './house.js', options: { fn: undefined } } },
      forge: { type: 'gitlab', repo: 'no-slash' }, worktrees: '../elsewhere', links: [{ label: 'x', href: 'javascript:alert(1)' }],
      proxy: { '/cornfield/': 'http://x', api: 'ftp://y' }, importMap: { a: 'https://cdn.example/a.js' }, personas: { roles: [1] },
    });
    const text = out.join('\n');
    for (const want of ['unknown key "colour"', '"port"', 'derivers[0] "nope"', 'derivers[1] "./../x.js" leaves the repo', 'derivers[2].options', 'sources.live "mystery"', 'sources.radio', 'forge.type', 'forge.repo', '"worktrees"', 'links[0]', 'proxy "/cornfield/" is cornfield', 'proxy "api"', '"importMap"', '"personas"']) {
      expect(text, want).toContain(want);
    }
  });
});

describe('the deploys key', () => {
  it('accepts workflow patterns and what they restart, and nothing else', () => {
    expect(configProblems({ deploys: { workflows: ['*deploy*'], restarts: { 'Deploy web': ['stack-web', 'media'] } } })).toEqual([]);
    expect(configProblems({ deploys: null })).toEqual([]);
    expect(configProblems({ deploys: [] })).toEqual(['"deploys" is { workflows, restarts }.']);
    expect(configProblems({ deploys: { run: [] } })).toEqual(['deploys.run: the keys are workflows, restarts.']);
    expect(configProblems({ deploys: { workflows: 'deploy' } })).toEqual(['deploys.workflows is a list of workflow names or patterns, like ["*deploy*"].']);
    expect(configProblems({ deploys: { restarts: [] } })).toEqual(['deploys.restarts is { "workflow name or pattern": ["node id or label"] }.']);
    expect(configProblems({ deploys: { restarts: { Deploy: 'stack-web' } } })).toEqual(['deploys.restarts["Deploy"] is a list of node ids or labels.']);
  });

  it('defaults to any workflow with "deploy" in its name, restarting nothing', async () => {
    expect(DEFAULTS.deploys).toEqual({ workflows: ['*deploy*'], restarts: {} });
    const config = await loadConfig(repo('export default { deploys: { restarts: { Ship: ["stack-web"] } } };'));
    expect(config.deploys).toEqual({ workflows: ['*deploy*'], restarts: { Ship: ['stack-web'] } });
  });
});

describe('the agents rules', () => {
  it('are empty by default, with bot accounts counted', async () => {
    const defaults = { authors: [], labels: [], branchPrefixes: [], bots: true, transport: 'forge', maxOpen: 3, profiles: [], runners: [], quietAfter: '24h', limits: {} };
    expect(DEFAULTS.agents).toEqual(defaults);
    const c = await loadConfig(repo(), { env: {} });
    expect(c.agents).toEqual(defaults);
    expect(c.agents).not.toBe(DEFAULTS.agents);
  });

  it('take the keys of the file over the defaults, and the rest stay', async () => {
    const c = await loadConfig(repo("export default { agents: { branchPrefixes: ['claude/'], labels: ['agent', 'needs human'], bots: false } };"), { env: {} });
    expect(c.agents).toMatchObject({ authors: [], labels: ['agent', 'needs human'], branchPrefixes: ['claude/'], bots: false, maxOpen: 3, quietAfter: '24h' });
  });

  it('are checked: the shape, the keys, and what a name may be', () => {
    expect(configProblems({ agents: { authors: ['claude-bot', 'renovate[bot]'], labels: ['agent', 'needs human'], branchPrefixes: ['claude/'], bots: false } })).toEqual([]);
    const text = configProblems({ agents: { authors: ['two words', ''], labels: 'agent', branchPrefixes: [1], bots: 'yes', colour: 1 } }).join('\n');
    for (const want of ['agents.authors is a list of account names', 'agents.labels is a list of label names', 'agents.branchPrefixes is a list of branch name starts', 'agents.bots is true or false', 'agents.colour']) expect(text, want).toContain(want);
    expect(configProblems({ agents: [] }).join()).toContain('"agents" is { authors');
  });
});

describe('the proposals key', () => {
  it('is the folder as a string, as it always was, and landing on approval is off', async () => {
    expect(configProblems({ proposals: 'docs/specs/proposals' })).toEqual([]);
    const plain = await loadConfig(repo(), { env: {} });
    expect(plain).toMatchObject({ proposals: 'docs/specs/proposals', approveLands: false });
    const named = await loadConfig(repo("export default { proposals: 'specs/proposals' };"), { env: {} });
    expect(named).toMatchObject({ proposals: 'specs/proposals', approveLands: false });
  });

  it('may be { dir?, approveLands? }: the folder stays what the rest of cornfield reads as `proposals`', async () => {
    for (const ok of [{}, { dir: 'specs' }, { approveLands: true }, { approveLands: false }, { dir: 'specs/p', approveLands: true }]) expect(configProblems({ proposals: ok }), JSON.stringify(ok)).toEqual([]);
    const on = await loadConfig(repo('export default { proposals: { approveLands: true } };'), { env: {} });
    expect(on).toMatchObject({ proposals: 'docs/specs/proposals', approveLands: true });
    const both = await loadConfig(repo("export default { proposals: { dir: 'specs/p', approveLands: true } };"), { env: {} });
    expect(both).toMatchObject({ proposals: 'specs/p', approveLands: true });
    const off = await loadConfig(repo("export default { proposals: { dir: 'specs/p' } };"), { env: {} });
    expect(off).toMatchObject({ proposals: 'specs/p', approveLands: false });
  });

  it('is checked strictly: an unknown key, a flag that is not true or false, a folder that leaves the repo', () => {
    expect(configProblems({ proposals: { approveLands: 'yes' } })).toEqual(['proposals.approveLands is true or false: whether approving a spec also lands its pull request once every check is green.']);
    for (const bad of [1, 'true', null, []]) expect(configProblems({ proposals: { approveLands: bad } }).join(), JSON.stringify(bad)).toContain('proposals.approveLands is true or false');
    expect(configProblems({ proposals: { approveland: true } })).toEqual(['proposals.approveland: the keys are dir, approveLands.']);
    for (const dir of ['../out', '/abs', '']) expect(configProblems({ proposals: { dir } }).join(), dir).toContain('proposals.dir is the proposals folder');
    expect(configProblems({ proposals: '../out' }).join()).toContain('"proposals" is the proposals folder inside the repo');
    expect(configProblems({ proposals: ['docs'] }).join()).toContain('"proposals" is the proposals folder');
    expect(configProblems({ proposals: 7 }).join()).toContain('"proposals"');
  });

  it('refuses a bad object, naming the file', async () => {
    await expect(loadConfig(repo('export default { proposals: { approveLands: 1 } };'), { env: {} })).rejects.toThrow(/cornfield\.config\.js:\n {2}proposals\.approveLands/);
  });
});

describe('hookPoll', () => {
  const specs = (v) => configProblems({ hookPoll: { specs: v } });

  it('takes durations from the 60s floor to the 1h ceiling, or false', () => {
    for (const v of ['60s', '90s', '5m', '59m', '1h', '3600s', '60m', false]) expect(specs(v), String(v)).toEqual([]);
    expect(configProblems({ hookPoll: false })).toEqual([]);
    expect(configProblems({ hookPoll: {} })).toEqual([]);
  });

  it('refuses under the floor and over the ceiling, naming the bound', () => {
    for (const v of ['59s', '1s', '30s']) expect(specs(v)[0], v).toMatch(/hookPoll\.specs .* under the floor of 60s/);
    for (const v of ['61m', '3601s', '2h']) expect(specs(v)[0], v).toMatch(/hookPoll\.specs .* over the ceiling of 1h/);
  });

  it('refuses anything that is not a duration, an unknown key and a wrong shape', () => {
    for (const v of ['5', '5 m', '5min', '0m', '1.5m', '-5m', '', 300, true, null, 'm', '5M']) expect(specs(v)[0], String(v)).toMatch(/hookPoll\.specs is a duration/);
    expect(configProblems({ hookPoll: { every: '5m' } })[0]).toMatch(/hookPoll\.every: the key is specs/);
    for (const v of [true, '5m', 300, [], null]) expect(configProblems({ hookPoll: v })[0], String(v)).toMatch(/"hookPoll" is \{ specs/);
  });

  it('parses durations to milliseconds', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('5')).toBeNull();
  });

  it('is on at 5m only when a hook subscribes to spec.ready, by name or with *; false turns it off', async () => {
    const hook = (events) => ({ url: 'https://a.example.org/h', events });
    const cfg = async (text) => loadConfig(repo(text), { env: {} });
    expect(DEFAULTS.hookPoll).toEqual({ specs: '5m' });
    expect(specPollMs(await cfg('export default {};'))).toBeNull();
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook(['pr.landed', 'spec.approved']))}] };`))).toBeNull();
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook(['spec.ready']))}] };`))).toBe(300_000);
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook('*'))}] };`))).toBe(300_000);
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook('*'))}], hookPoll: { specs: '90s' } };`))).toBe(90_000);
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook('*'))}], hookPoll: { specs: false } };`))).toBeNull();
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook('*'))}], hookPoll: false };`))).toBeNull();
    expect(specPollMs(await cfg(`export default { hookPoll: { specs: '2m' } };`))).toBeNull();
  });

  it('fails the config at load with the key named', async () => {
    await expect(loadConfig(repo("export default { hookPoll: { specs: '10s' } };"), { env: {} })).rejects.toThrow(/cornfield\.config\.js:\n {2}hookPoll\.specs "10s" is under the floor/);
  });
});

describe('threads', () => {
  const hook = (events) => ({ url: 'https://a.example.org/h', events });
  const cfg = async (text) => loadConfig(repo(text), { env: {} });

  it('defaults to the idea label; false turns threads off; the shape is strict', async () => {
    expect(DEFAULTS.threads).toEqual({ label: 'idea' });
    expect((await cfg('export default {};')).threads).toEqual({ label: 'idea' });
    expect((await cfg("export default { threads: { label: 'rfc' } };")).threads).toEqual({ label: 'rfc' });
    expect((await cfg('export default { threads: false };')).threads).toBe(false);
    expect(configProblems({ threads: false })).toEqual([]);
    expect(configProblems({ threads: {} })).toEqual([]);
    expect(configProblems({ threads: { label: 'idea' } })).toEqual([]);
    for (const v of [true, 'idea', 5, [], null]) expect(configProblems({ threads: v })[0], String(v)).toMatch(/"threads" is \{ label/);
    expect(configProblems({ threads: { labels: ['a'] } })[0]).toMatch(/threads\.labels: the key is label/);
    for (const v of ['', ' ', ' idea', 'a,b', 'x'.repeat(51), 7, null, ['idea']]) expect(configProblems({ threads: { label: v } })[0], String(v)).toMatch(/threads\.label is the name of the label/);
  });

  it('the thread events are hook events, and a hook that wants one turns the poll on unless threads or the poll are off', async () => {
    for (const e of ['thread.opened', 'thread.message', 'thread.linked']) expect(HOOK_EVENTS).toContain(e);
    expect(configProblems({ hooks: [hook(['thread.message', 'thread.linked'])] })).toEqual([]);
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook(['thread.opened']))}] };`))).toBe(300_000);
    expect(specPollMs(await cfg(`export default { threads: false, hooks: [${JSON.stringify(hook(['thread.opened']))}] };`))).toBeNull();
    expect(specPollMs(await cfg(`export default { threads: false, hooks: [${JSON.stringify(hook('*'))}] };`))).toBe(300_000);
    expect(specPollMs(await cfg(`export default { hookPoll: false, hooks: [${JSON.stringify(hook(['thread.opened']))}] };`))).toBeNull();
    expect(specPollMs(await cfg(`export default { hooks: [${JSON.stringify(hook(['thread.opened']))}], hookPoll: { specs: '2m' } };`))).toBe(120_000);
  });
});

describe('loadConfig', () => {
  it('fills the defaults, names the title from package.json, and keeps the data folder out of the repo', async () => {
    const root = repo();
    const c = await loadConfig(root, { env: {} });
    expect(c).toMatchObject({ title: 'demo', port: 3350, host: '127.0.0.1', derivers: DEFAULTS.derivers, proposals: 'docs/specs/proposals', worktrees: '.claude/worktrees', root, configFile: null });
    expect(path.relative(root, c.dataDir).startsWith('..')).toBe(true);
    expect(c.dataDir).toContain('.cornfield');
  });

  it('reads the file, and env vars win over it for what differs per machine', async () => {
    const root = repo("export default { title: 'From the file', port: 4000, links: [{ label: 'Docs', href: '/docs' }] };");
    const c = await loadConfig(root, { env: { CORNFIELD_PORT: '4100', CORNFIELD_HOST: '::1', CORNFIELD_PUBLIC_URL: 'https://dash.example.org', CORNFIELD_DATA: '/tmp/cf' } });
    expect(c).toMatchObject({ title: 'From the file', port: 4100, host: '::1', publicUrl: 'https://dash.example.org', dataDir: '/tmp/cf', links: [{ label: 'Docs', href: '/docs' }] });
  });

  it('refuses a config with problems, naming the file', async () => {
    const root = repo('export default { port: "eighty" };');
    await expect(loadConfig(root, { env: {} })).rejects.toThrow(/cornfield\.config\.js:\n {2}"port"/);
  });
});

describe('loadDerivers and browserSources', () => {
  it('loads the built-in derivers by name, and a repo\'s own by path, each with its options', async () => {
    const root = repo("export default { derivers: ['starter', { use: './tools/mine.js', options: { a: 1 } }] };");
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools/mine.js'), "export default { name: 'mine', contract: 1, derive: () => ({ nodes: [], edges: [] }) };");
    const loaded = await loadDerivers(await loadConfig(root, { env: {} }));
    expect(loaded.map((d) => d.deriver.name)).toEqual(['starter', 'mine']);
    expect(loaded[1].options).toEqual({ a: 1 });
  });

  it('says which deriver file is missing', async () => {
    const root = repo("export default { derivers: ['./tools/gone.js'] };");
    await expect(loadDerivers(await loadConfig(root, { env: {} }))).rejects.toThrow(/gone\.js does not exist/);
  });

  it('serves a built-in source from cornfield and a repo\'s own under /repo/, with its options', async () => {
    const c = await loadConfig(SAMPLE, { env: {} });
    expect(browserSources(c)).toEqual({ live: null, house: { module: '/plugins/house/browser.js', options: { file: 'cornfield.house.json' } }, devices: null, checker: null });
    const own = browserSources({ sources: { live: { use: './tools/live.js', options: { url: '/api/world' } } } });
    expect(own.live).toEqual({ module: '/repo/tools/live.js', options: { url: '/api/world' } });
    expect(fs.existsSync(path.join(CORNFIELD, 'plugins/house/browser.js'))).toBe(true);
  });
});

describe('the agents keys that ask for and follow runs (spec 0005)', () => {
  it('are checked strictly: transport, maxOpen, profiles, runners, quietAfter and limits', () => {
    expect(configProblems({ agents: { transport: 'forge', maxOpen: 5, profiles: ['claude', 'local-qwen'], runners: ['claude-bot', 'ci[bot]'], quietAfter: '12h', limits: { minutes: 30, turns: 40, cost: 2.5 } } })).toEqual([]);
    const text = configProblems({ agents: { transport: 'telegram', maxOpen: 0, profiles: ['two words', 'a', 'a'], runners: ['has space'], quietAfter: '1m', limits: { minutes: -1, turns: 1.5, tokens: 3 } } }).join('\n');
    for (const want of ['agents.transport is "forge"', 'agents.maxOpen is a whole number from 1 to 100', 'agents.profiles is a list', 'agents.runners is a list', 'under the floor of 5m', 'agents.limits.minutes is a number above zero', 'agents.limits.turns is a whole number', 'agents.limits.tokens: the keys are']) expect(text).toContain(want);
    expect(configProblems({ agents: { quietAfter: '90 days' } }).join()).toContain('agents.quietAfter is a duration');
    expect(configProblems({ agents: { quietAfter: '9999h' } }).join()).toContain('over the ceiling');
  });

  it('read quietAfter with the duration parser of hookPoll', async () => {
    const { quietAfterMs } = await import('../../core/config.js');
    expect(quietAfterMs({ agents: {} })).toBe(24 * 3_600_000);
    expect(quietAfterMs({ agents: { quietAfter: '90m' } })).toBe(90 * 60_000);
    const c = await loadConfig(repo("export default { agents: { runners: ['claude-bot'], profiles: ['claude'] } };"), { env: {} });
    expect(c.agents).toMatchObject({ transport: 'forge', maxOpen: 3, runners: ['claude-bot'], profiles: ['claude'], quietAfter: '24h' });
  });
});
