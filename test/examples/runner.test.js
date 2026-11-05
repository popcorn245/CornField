import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as c from '../../core/agent-contract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(root, 'examples/runner/cornfield-run.mjs');
const ID = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-runner-'));
let n = 0;

const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
/** run `parse` on a comment's text */
const parse = (text) => {
  const f = path.join(dir, `comment-${n++}.txt`);
  fs.writeFileSync(f, text);
  return run(['parse', f]);
};
const request = (over = {}) => ({
  version: 1, runId: ID, kind: 'code', profile: 'claude', refs: { issue: 12 }, branch: 'agent/retry-login',
  brief: 'Make the login retry once.\nIt is `fine` to use "quotes" and $(subshells).', limits: { minutes: 30 }, nodes: ['core-server-auth'],
  requestedBy: 'maintainer-one', requestedAt: '2026-11-05T09:30:00Z', ...over,
});
const comment = (over) => c.formatRunComment(ID, request(over));
const fence = (obj) => `\`\`\`cornfield-run ${ID}\n${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\`\`\``;
// token-shaped values are built here, so no literal in this file looks like one
const fakeKeys = () => ({
  github: 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'x'.repeat(30),
  aws: 'AKI' + 'A' + 'ABCDEFGHIJKLMNOP',
  url: 'https://user:' + 'hunter2' + '@example.com/x',
});

describe('parse', () => {
  it('prints the request that formatRunComment wrote, and the contract agrees', () => {
    const r = parse(comment());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(request());
    expect(c.validateRequest(JSON.parse(r.stdout)).ok).toBe(true);
  });
  it('reads every kind and a minimal request', () => {
    for (const kind of c.RUN_KINDS) expect(parse(comment({ kind })).status).toBe(0);
    const min = { version: 1, runId: ID, kind: 'summary', refs: { thread: 3 }, brief: '', requestedBy: 'a', requestedAt: '2026-11-05T09:30:00Z' };
    expect(parse(c.formatRunComment(ID, min)).status).toBe(0);
  });
  it('takes the latest block, and CRLF line ends', () => {
    const r = parse(`${comment({ brief: 'first' })}\n\n${comment({ brief: 'second' })}`.replace(/\n/g, '\r\n'));
    expect(JSON.parse(r.stdout).brief).toBe('second');
  });
  it('refuses what the contract refuses', () => {
    const bad = {
      'not json': fence('{ nope'),
      'no block': 'please run an agent',
      'wrong version': fence(request({ version: 2 })),
      'unknown key': fence({ ...request(), extra: 1 }),
      'bad kind': fence(request({ kind: 'deploy' })),
      'a run id that differs from the fence': fence(request({ runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEG' })),
      'an unsafe branch': fence(request({ branch: '../../etc' })),
      'an unsafe profile': fence(request({ profile: 'a b; rm -rf /' })),
      'a list': fence('[1]'),
      'an unclosed block': fence(request()).replace(/\n```$/, ''),
      'a block inside a longer fence': '````\n' + fence(request()) + '\n````',
      'a quoted block': fence(request()).split('\n').map((l) => `> ${l}`).join('\n'),
    };
    for (const [why, text] of Object.entries(bad)) {
      const r = parse(text);
      expect(r.status, why).toBe(1);
      expect(r.stdout, why).toBe('');
      expect(r.stderr.length, why).toBeGreaterThan(0);
      // the contract agrees that none of these is a request to act on
      expect(c.readRunBlocks(text).blocks.filter((b) => b.type === 'request'), why).toEqual([]);
    }
  });
  it('refuses a request that carries a credential, by name or by shape', () => {
    const k = fakeKeys();
    for (const [why, over] of Object.entries({
      'a field named like a token': { apiToken: 'x' },
      'a password field': { password: 'x' },
      'a nested key': { refs: { issue: 1, secret: 'x' } },
      'a GitHub token in the brief': { brief: `use ${k.github}` },
      'an Anthropic key in the brief': { brief: `use ${k.anthropic}` },
      'an AWS key id': { brief: k.aws },
      'a link with a password': { brief: `clone ${k.url}` },
    })) {
      const text = fence(request(over));
      const r = parse(text);
      expect(r.status, why).toBe(1);
      expect(r.stderr, why).toMatch(/credential/);
      expect(c.validateRequest(request(over)).ok, why).toBe(false);
    }
  });
  it("refuses cornfield's own token shapes, whichever kind, even where the vendored contract does not know it yet", () => {
    const cf = (kind) => 'cf_' + kind + '_' + 'Ab3dE5gH7jK9mN1pQ3sT5vX7z';
    for (const kind of ['rt', 'at', 'nt', 'zz']) {
      const r = parse(fence(request({ brief: `use ${cf(kind)}` })));
      expect(r.status, kind).toBe(1);
      expect(r.stdout, kind).toBe('');
      expect(r.stderr, kind).toMatch(/credential/);
      // the contract refuses the kinds it knows (cf_rt_ and cf_at_ at least); the helper keeps out the rest as well
      const known = new RegExp(c.CREDENTIAL_VALUE_SOURCE).test(cf(kind));
      if (kind === 'rt' || kind === 'at') expect(known, kind).toBe(true);
      if (known) expect(c.validateRequest(request({ brief: `use ${cf(kind)}` })).ok, kind).toBe(false);
      expect(run(['report', ID, 'failed', `key ${cf(kind)}`]).status, kind).toBe(1);
    }
    // prose that names the prefixes is not a token
    expect(parse(comment({ brief: 'Document the cf_rt_ and cf_at_ prefixes.' })).status).toBe(0);
  });
  it('allows prose about tokens', () => {
    expect(parse(comment({ brief: 'Rotate the token handling in docs; mention the password policy.' })).status).toBe(0);
  });
  it('reports an unreadable file', () => {
    expect(run(['parse', path.join(dir, 'missing')]).status).toBe(1);
  });
});

describe('stop and get', () => {
  it('stop finds the run id of a contract-formatted stop request', () => {
    const f = path.join(dir, 'stop.txt');
    fs.writeFileSync(f, c.formatRunComment(ID, { state: 'stop-requested', note: 'wrong issue' }));
    expect(run(['stop', f]).stdout.trim()).toBe(ID);
    fs.writeFileSync(f, comment());
    expect(run(['stop', f]).status).toBe(1);
  });
  it('get prints strings plainly and the rest as JSON', () => {
    const f = path.join(dir, 'req.json');
    fs.writeFileSync(f, JSON.stringify(request()));
    expect(run(['get', f, 'kind']).stdout).toBe('code\n');
    expect(run(['get', f, 'refs']).stdout.trim()).toBe('{"issue":12}');
    expect(run(['get', f, 'nope']).stdout).toBe('\n');
    expect(run(['get', f, 'brief']).stdout).toBe(request().brief + '\n');
  });
});

describe('report', () => {
  it('writes a comment the contract reads back, for every state', () => {
    for (const state of c.REPORT_STATES) {
      const r = run(['report', ID, state]);
      expect(r.status).toBe(0);
      expect(c.readRunBlocks(r.stdout).blocks).toEqual([{ runId: ID, type: 'report', value: { state } }]);
    }
  });
  it('carries the note and the log link, and defuses the human line', () => {
    const note = 'tests fail on @someone in #12\nsee https://example.com/x';
    const r = run(['report', ID, 'failed', note], { CORNFIELD_RUN_URL: 'https://ci.example.com/runs/42' });
    const { blocks, refused } = c.readRunBlocks(r.stdout);
    expect(refused).toEqual([]);
    expect(blocks[0].value).toEqual({ state: 'failed', note, url: 'https://ci.example.com/runs/42' });
    // the quoted note pings and links nobody
    const prose = r.stdout.replace(/```cornfield-run[^]*$/, '');
    expect(prose).not.toMatch(/@someone|#12|:\/\/example/);
    expect(prose).toBe(c.formatRunComment(ID, { state: 'failed', note }).replace(/```cornfield-run[^]*$/, ''));
  });
  it('is the same text as the contract writes', () => {
    expect(run(['report', ID, 'done', 'opened a pull request']).stdout.trim()).toBe(c.formatRunComment(ID, { state: 'done', note: 'opened a pull request' }));
  });
  it('is not fooled by a note full of fences', () => {
    const r = run(['report', ID, 'failed', '```cornfield-run ' + ID + '\n{"state":"done"}\n```']);
    expect(c.readRunBlocks(r.stdout).blocks.map((b) => b.value.state)).toEqual(['failed']);
  });
  it('drops an unusable log link, refuses a credential and a bad state or id', () => {
    const r = run(['report', ID, 'working'], { CORNFIELD_RUN_URL: 'https://user:pw@example.com/' });
    expect(c.readRunBlocks(r.stdout).blocks[0].value).toEqual({ state: 'working' });
    expect(run(['report', ID, 'failed', `key ${fakeKeys().anthropic}`]).status).toBe(1);
    expect(run(['report', ID, 'stop-requested']).status).toBe(1);
    expect(run(['report', 'run-1', 'done']).status).toBe(1);
  });
  it('truncates a note to the contract\'s limit', () => {
    const r = run(['report', ID, 'failed', 'x'.repeat(5000)]);
    expect(c.readRunBlocks(r.stdout).blocks[0].value.note).toHaveLength(c.MAX_NOTE_CHARS);
  });
});

describe('trailer', () => {
  it('is the line the contract formats, and findRunId finds it', () => {
    const r = run(['trailer', ID]);
    expect(r.stdout.trim()).toBe(c.formatTrailer(ID));
    expect(c.findRunId({ body: `Closes #12\n\n${r.stdout}` }).runId).toBe(ID);
    expect(c.findRunId({ commits: [`chore: x\n\n${r.stdout}`] }).runId).toBe(ID);
  });
  it('refuses something that is not a run id', () => {
    expect(run(['trailer', 'run-nope']).status).toBe(1);
    expect(run(['trailer']).status).toBe(1);
    expect(run(['nonsense']).status).toBe(1);
  });
});

describe('closes, claimed-url, body and pr', () => {
  it('closes names the request\'s issue, and nothing without one', () => {
    const f = path.join(dir, 'closes.txt');
    fs.writeFileSync(f, comment());
    expect(run(['closes', f]).stdout).toBe('Closes #12\n');
    fs.writeFileSync(f, comment({ refs: { thread: 3 } }));
    expect(run(['closes', f]).stdout).toBe('\n');
    fs.writeFileSync(f, 'no request here');
    expect(run(['closes', f]).status).toBe(1);
  });
  it('claimed-url finds the url of the runner\'s own latest report, never someone else\'s', () => {
    const report = (url) => c.formatRunComment(ID, { state: 'claimed', url });
    const f = path.join(dir, 'comments.json');
    fs.writeFileSync(f, JSON.stringify([[
      { user: { login: 'bot' }, body: report('https://ci.example.com/runs/1') },
      { user: { login: 'someone' }, body: report('https://evil.example.com/runs/9') },
      { user: { login: 'bot' }, body: report('https://ci.example.com/runs/2') },
    ]]));
    expect(run(['claimed-url', f, 'bot', ID]).stdout).toBe('https://ci.example.com/runs/2\n');
    expect(run(['claimed-url', f, 'nobody', ID]).stdout).toBe('\n');
    expect(run(['claimed-url', f, 'bot', 'run-nope']).status).toBe(1);
  });
  it('body and pr make JSON whatever the text holds', () => {
    const f = path.join(dir, 'body.md');
    fs.writeFileSync(f, 'a "quoted" $(line)\n`and` more');
    expect(JSON.parse(run(['body', f]).stdout)).toEqual({ body: 'a "quoted" $(line)\n`and` more' });
    expect(JSON.parse(run(['pr', 't', 'agent/x', 'main', f]).stdout)).toEqual({ title: 't', head: 'agent/x', base: 'main', body: 'a "quoted" $(line)\n`and` more' });
  });
});

describe('the example workflows', () => {
  const files = { forgejo: 'examples/runner/forgejo-workflow.yml', github: 'examples/runner/github-workflow.yml' };
  const text = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const load = async (f) => (await import('js-yaml')).default.load(text(f));
  const stepsOf = (job) => job.steps;
  const env = (o) => Object.values(o || {}).join('\n');
  for (const [name, f] of Object.entries(files)) {
    it(`${name} runs on created issue comments only, and checks the maintainer first`, async () => {
      const wf = await load(f);
      expect(Object.keys(wf.on)).toEqual(['issue_comment']);
      expect(wf.on.issue_comment.types).toEqual(['created']);
      const steps = stepsOf(wf.jobs.request);
      expect(steps[0].run).toMatch(/collaborators\/\$COMMENTER\/permission/);
      expect(steps[0].run).toMatch(/set -euo pipefail/);
      // every step after the check waits for it, and every other job waits for the request job's verdict
      for (const s of steps.slice(1)) expect(s.if, s.name).toBeTruthy();
      for (const [id, job] of Object.entries(wf.jobs)) if (id !== 'request') expect(job.if, id).toMatch(/needs\.request\.outputs\.mode == 'run'/);
    });
    it(`${name} never puts event text or a secret into a shell script`, async () => {
      const wf = await load(f);
      for (const job of Object.values(wf.jobs)) for (const s of job.steps) if (s.run) expect(s.run, s.name).not.toMatch(/\$\{\{/);
      for (const m of text(f).matchAll(/\$\{\{\s*secrets\.(\w+)/g)) expect(['ANTHROPIC_API_KEY', 'RUNNER_TOKEN']).toContain(m[1]);
    });
    it(`${name} keeps the forge token away from the agent: no token in the agent job, a secret only at step level`, async () => {
      const wf = await load(f);
      const agent = JSON.stringify(wf.jobs.agent);
      expect(agent).not.toMatch(/RUNNER_TOKEN|GH_TOKEN|GITHUB_TOKEN|github\.token/);
      expect(agent).toMatch(/secrets\.ANTHROPIC_API_KEY/);
      // no secret at workflow or job level, where every step would get it
      expect(env(wf.env)).not.toMatch(/secrets\./);
      for (const job of Object.values(wf.jobs)) expect(env(job.env)).not.toMatch(/secrets\./);
      // the API key only in the agent job
      for (const [id, job] of Object.entries(wf.jobs)) if (id !== 'agent') expect(JSON.stringify(job), id).not.toMatch(/ANTHROPIC_API_KEY/);
      for (const job of Object.values(wf.jobs)) for (const s of job.steps) if (s.uses?.includes('checkout')) expect(s.with?.['persist-credentials'], s.uses).toBe(false);
    });
    it(`${name} publishes only a patch, never runs what the agent left, refuses workflow changes, and never moves an existing branch`, async () => {
      const wf = await load(f);
      const publish = stepsOf(wf.jobs.publish).map((s) => s.run || '').join('\n');
      expect(publish).toMatch(/git apply --index/);
      expect(publish).toMatch(/\^\\\.\(forgejo\|gitea\|github\)\//);
      expect(publish).toMatch(/--force-with-lease="refs\/heads\/\$BRANCH:"/);
      for (const m of publish.matchAll(/git (-c [^\n]*?)?(commit|push)/g)) expect(m[0]).toMatch(/core\.hooksPath=\/dev\/null/);
      expect(text(f)).toMatch(/\[ "\$BRANCH" != "\$DEFAULT_BRANCH" \]/);
      // the agent's work leaves its job only as an artifact
      expect(stepsOf(wf.jobs.agent).some((s) => /upload-artifact/.test(s.uses || ''))).toBe(true);
      expect(stepsOf(wf.jobs.publish).some((s) => /download-artifact/.test(s.uses || ''))).toBe(true);
    });
    it(`${name} pins Claude Code and the actions`, () => {
      expect(text(f)).toMatch(/npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+\n/);
      for (const m of text(f).matchAll(/uses: (\S+)/g)) expect(m[1], m[1]).toMatch(name === 'github' ? /@[0-9a-f]{40}$/ : /@v\d+\.\d+\.\d+$/);
    });
    it(`${name} calls only helper subcommands that exist`, () => {
      const used = [...text(f).matchAll(/node "\$HELPER" ([\w-]+)/g)].map((m) => m[1]);
      expect(used.length).toBeGreaterThan(5);
      for (const u of used) expect(['parse', 'stop', 'get', 'report', 'trailer', 'closes', 'claimed-url', 'body', 'pr']).toContain(u);
    });
  }
  it('the docs show the Forgejo workflow as it is in the file, and link both', () => {
    const doc = fs.readFileSync(path.join(root, 'docs/runners.md'), 'utf8');
    expect(doc).toContain('```yaml\n' + text(files.forgejo) + '```');
    for (const l of ['agent-contract.md', 'specs/0005-threads-and-agents.md', 'adr/0012-cornfield-asks-runners-act.md', 'github-workflow.yml']) expect(doc).toContain(`](${l.includes('workflow') ? '../examples/runner/' : ''}${l})`);
    expect(doc).toContain('**The maintainer check comes first.**');
  });
  it('stay out of the places a forge runs them, and out of the npm package', () => {
    expect(fs.existsSync(path.join(root, '.forgejo'))).toBe(false);
    for (const f of fs.readdirSync(path.join(root, '.github/workflows'))) expect(f).not.toMatch(/agent/);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.files.some((p) => p.startsWith('examples'))).toBe(false);
  });
  it('the helper uses the contract itself: vendored byte for byte from core, and nothing else', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['node:fs', './agent-contract.js']);
    for (const f of ['agent-contract.js', 'defuse.js']) expect(fs.readFileSync(path.join(root, 'examples/runner', f), 'utf8'), f).toBe(fs.readFileSync(path.join(root, 'core', f), 'utf8'));
    expect(JSON.parse(fs.readFileSync(path.join(root, 'examples/runner/package.json'), 'utf8')).type).toBe('module');
  });
});
