import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as c from '../../core/agent-contract.js';
import { ZW } from '../../core/defuse.js';

const ID = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEF';
const ID2 = 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEG';
const request = (over = {}) => ({ version: 1, runId: ID, kind: 'code', refs: { issue: 12 }, brief: 'Fix it.', requestedBy: 'maintainer-one', requestedAt: '2026-11-05T09:30:00Z', ...over });
const full = () => request({
  profile: 'claude', refs: { issue: 12, proposal: '0014-planner', thread: 30 }, branch: 'agent/fix-auth', brief: 'Make the login retry.\nKeep it small.',
  limits: { minutes: 30, turns: 40, cost: 2.5 }, nodes: ['core-server-auth', 'server/auth.js'],
});
const refuse = (body, opts) => {
  const r = c.validateRequest(body, opts);
  expect(r.ok).toBe(false);
  return r.error;
};
const fenced = (id, obj) => `\`\`\`cornfield-run ${id}\n${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\`\`\``;

describe('run ids', () => {
  it('are run- and 26 Crockford characters, and sort by time', () => {
    const id = c.newRunId({ now: () => 1_762_334_400_000 });
    expect(id).toMatch(/^run-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(c.isRunId(id)).toBe(true);
    expect(c.newRunId({ now: () => 1_762_334_400_001 }) > id).toBe(true);
  });
  it('encode the clock and the bytes exactly', () => {
    expect(c.newRunId({ now: () => 0, random: () => new Uint8Array(10) })).toBe('run-' + '0'.repeat(26));
    expect(c.newRunId({ now: () => 2 ** 48 - 1, random: () => new Uint8Array(10).fill(255) })).toBe('run-' + '7ZZZZZZZZZ' + 'Z'.repeat(16));
    expect(c.newRunId({ now: () => 32, random: () => Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) })).toBe('run-' + '0000000010' + '0'.repeat(15) + '1');
  });
  it('read their time back', () => {
    expect(c.runIdTime(c.newRunId({ now: () => 1_762_334_400_123 })).getTime()).toBe(1_762_334_400_123);
    expect(c.runIdTime('nope')).toBeNull();
  });
  it('differ on the same millisecond, using real randomness by default', () => {
    const now = () => 1_762_334_400_000;
    expect(c.newRunId({ now })).not.toBe(c.newRunId({ now }));
  });
  it('refuse a clock that cannot make one', () => {
    for (const t of [-1, NaN, 2 ** 48, 1.5]) expect(() => c.newRunId({ now: () => t })).toThrow(RangeError);
    expect(() => c.newRunId({ random: () => new Uint8Array(3) })).toThrow(/ten random bytes/);
  });
  it('are only run ids when well formed', () => {
    for (const bad of ['', 'run-', 'run-01JC8Z3Q5M7VXK2RT9N4B6HDE', ID + 'X', 'RUN-01JC8Z3Q5M7VXK2RT9N4B6HDEF', 'run-01JC8Z3Q5M7VXK2RT9N4B6HDEI', 'run-81JC8Z3Q5M7VXK2RT9N4B6HDEF', 'run-01jc8z3q5m7vxk2rt9n4b6hdef', 4, null, undefined]) expect(c.isRunId(bad)).toBe(false);
  });
});

describe('validateRequest', () => {
  it('takes the smallest request and the full one, as copies in contract order', () => {
    const small = c.validateRequest(request());
    expect(small).toEqual({ ok: true, value: request() });
    const body = full();
    const r = c.validateRequest(body);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(body);
    expect(Object.keys(r.value)).toEqual(['version', 'runId', 'kind', 'profile', 'refs', 'branch', 'brief', 'limits', 'nodes', 'requestedBy', 'requestedAt']);
    r.value.refs.issue = 99;
    r.value.nodes.push('x');
    expect(body.refs.issue).toBe(12);
    expect(body.nodes).toHaveLength(2);
  });
  it('wants an object', () => {
    for (const bad of [null, [], 'x', 3, undefined]) expect(refuse(bad)).toMatch(/JSON object/);
  });
  it('refuses unknown keys by name', () => {
    expect(refuse(request({ extra: 1 }))).toBe('A request has "extra", which the contract does not have.');
    expect(refuse(request({ refs: { issue: 1, pr: 2 } }))).toBe('"refs" has "pr", which the contract does not have.');
    expect(refuse(request({ limits: { hours: 2 } }))).toBe('"limits" has "hours", which the contract does not have.');
    expect(refuse(JSON.parse('{"__proto__": {"x": 1}, "version": 1}'))).toMatch(/__proto__/);
  });
  it('checks the version', () => {
    for (const v of [2, '1', 0, undefined, null]) expect(refuse(request({ version: v }))).toMatch(/"version" is 1/);
    const { version, ...rest } = request();
    expect(refuse(rest)).toMatch(/"version" is 1/);
  });
  it('checks the run id', () => {
    for (const v of ['run-1', ID.toLowerCase(), 7, undefined]) expect(refuse(request({ runId: v }))).toMatch(/"runId" is "run-"/);
  });
  it('checks the kind', () => {
    for (const kind of c.RUN_KINDS) expect(c.validateRequest(request({ kind })).ok).toBe(true);
    for (const v of ['build', 'Code', '', undefined]) expect(refuse(request({ kind: v }))).toBe('"kind" is one of code, summary, brief, proposal.');
  });
  describe('profile', () => {
    it('is optional and any well formed name without a list', () => {
      expect(c.validateRequest(request({ profile: 'local-qwen.7b' })).ok).toBe(true);
      for (const bad of ['', '-x', 'a b', 'a'.repeat(65), 3]) expect(refuse(request({ profile: bad }))).toMatch(/"profile" is a name/);
    });
    it('must be on the list when there is one', () => {
      const profiles = ['claude', 'local-qwen'];
      expect(c.validateRequest(request({ profile: 'claude' }), { profiles }).ok).toBe(true);
      expect(c.validateRequest(request(), { profiles }).ok).toBe(true);
      expect(refuse(request({ profile: 'gpt' }), { profiles })).toBe('"profile" "gpt" is not one of the configured profiles (claude, local-qwen).');
      expect(refuse(request({ profile: 'gpt' }), { profiles: [] })).toMatch(/\(none\)/);
    });
  });
  describe('refs', () => {
    it('needs at least one', () => {
      expect(refuse(request({ refs: {} }))).toMatch(/at least one/);
      for (const bad of [undefined, null, [], 'x']) expect(refuse(request({ refs: bad }))).toMatch(/"refs" says what/);
    });
    it('takes any one of issue, proposal, thread', () => {
      for (const refs of [{ issue: 1 }, { proposal: '0014-planner' }, { thread: 2147483647 }]) expect(c.validateRequest(request({ refs })).ok).toBe(true);
    });
    it('checks each', () => {
      for (const f of ['issue', 'thread']) for (const bad of [0, -1, 1.5, '12', 2147483648, null]) expect(refuse(request({ refs: { [f]: bad } }))).toBe(`"refs.${f}" is a number from 1, like 12.`);
      for (const bad of ['', '../x', 'a/b', 'a b', 4, 'x'.repeat(121)]) expect(refuse(request({ refs: { proposal: bad } }))).toMatch(/"refs.proposal"/);
    });
  });
  describe('branch', () => {
    it('takes safe ref names', () => {
      for (const b of ['main', 'agent/fix-auth', 'claude/run-01JC8Z3Q5M7VXK2RT9N4B6HDEF', 'v1.2.3', 'a_b/c-d']) expect(c.validateRequest(request({ branch: b })).ok).toBe(true);
    });
    it('refuses unsafe ones, naming the field', () => {
      const bad = ['', '-rf', '--upload-pack=x', '/abs', 'trail/', 'a//b', 'a..b', 'end.', '.hidden', 'a/.b', 'a.lock', 'a.lock/b', 'sp ace', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'a\nb', 'é', 'x'.repeat(201), 5];
      for (const b of bad) expect(refuse(request({ branch: b })), JSON.stringify(b)).toMatch(/^"branch" /);
    });
    it('explains', () => {
      expect(c.branchProblem('-x')).toMatch(/dash/);
      expect(c.branchProblem('a..b')).toMatch(/\.\./);
      expect(c.branchProblem('ok/fine')).toBeNull();
    });
  });
  describe('brief', () => {
    it('is text up to the cap', () => {
      expect(c.validateRequest(request({ brief: '' })).ok).toBe(true);
      expect(c.validateRequest(request({ brief: 'x'.repeat(c.MAX_BRIEF_CHARS) })).ok).toBe(true);
      expect(refuse(request({ brief: 'x'.repeat(c.MAX_BRIEF_CHARS + 1) }))).toBe(`"brief" is at most ${c.MAX_BRIEF_CHARS} characters.`);
      expect(refuse(request({ brief: 5 }))).toBe('"brief" is text.');
    });
  });
  describe('limits', () => {
    it('are positive numbers', () => {
      expect(c.validateRequest(request({ limits: {} })).ok).toBe(true);
      expect(c.validateRequest(request({ limits: { minutes: 0.5, turns: 1, cost: 0.01 } })).ok).toBe(true);
      for (const f of ['minutes', 'turns', 'cost']) for (const bad of [0, -1, '5', NaN, Infinity, null]) expect(refuse(request({ limits: { [f]: bad } }))).toBe(`"limits.${f}" is a number above zero.`);
      expect(refuse(request({ limits: { turns: 2.5 } }))).toBe('"limits.turns" is a whole number.');
      for (const bad of [[], 'x', null]) expect(refuse(request({ limits: bad }))).toMatch(/"limits" is/);
    });
  });
  describe('nodes', () => {
    it('are a list of ids', () => {
      expect(c.validateRequest(request({ nodes: [] })).ok).toBe(true);
      expect(refuse(request({ nodes: 'a' }))).toMatch(/list of node ids/);
      expect(refuse(request({ nodes: ['ok', ' bad'] }))).toMatch(/^Node 2 of "nodes"/);
      expect(refuse(request({ nodes: [3] }))).toMatch(/^Node 1/);
      expect(refuse(request({ nodes: Array.from({ length: 101 }, (_, i) => `n${i}`) }))).toMatch(/at most 100/);
    });
  });
  describe('requestedBy and requestedAt', () => {
    it('are a login and a UTC time', () => {
      for (const ok of ['a', 'maintainer-one', 'Jo.Smith_2', 'x'.repeat(40)]) expect(c.validateRequest(request({ requestedBy: ok })).ok).toBe(true);
      for (const bad of ['', '-a', 'a b', 'a@b', 'x'.repeat(41), 4, undefined, 'bot[bot]']) expect(refuse(request({ requestedBy: bad }))).toMatch(/"requestedBy" is a forge login/);
      for (const ok of ['2026-11-05T09:30:00Z', '2026-11-05T09:30:00.123Z', '2024-02-29T00:00:00Z']) expect(c.validateRequest(request({ requestedAt: ok })).ok).toBe(true);
      for (const bad of ['2026-11-05', '2026-11-05T09:30:00+01:00', '2026-11-05 09:30:00Z', 1762334400, undefined]) expect(refuse(request({ requestedAt: bad }))).toMatch(/^"requestedAt" is a UTC time/);
      for (const bad of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-11-05T25:00:00Z']) expect(refuse(request({ requestedAt: bad }))).toMatch(/^"requestedAt" is a real date/);
    });
  });
  describe('credentials', () => {
    it('refuses a field named like one, whatever the case', () => {
      for (const key of ['token', 'githubToken', 'api_key', 'apiKey', 'API-KEY', 'secret', 'client_secret', 'password', 'passwd', 'credentials', 'authorization', 'bearer', 'cookie', 'private_key', 'ssh-key', 'access_key', 'runnerToken']) {
        expect(refuse(request({ [key]: 'x' })), key).toBe(`A request has "${key}", which looks like a credential. A request never carries one: the runner uses its own identity.`);
      }
      expect(refuse(request({ refs: { issue: 1, token: 'x' } }))).toMatch(/^"refs" has "token", which looks like a credential/);
      expect(refuse(request({ limits: { password: 1 } }))).toMatch(/^"limits" has "password"/);
    });
    it('refuses a value shaped like one, in any text field', () => {
      const secrets = [
        'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'github_' + 'pat_11ABCDEFG0abcdefghijkl_mnopqrstuv', 'glp' + 'at-abcdefghij0123456789', 'sk-' + 'ant-api03-abcdefghijklmnopqrstu',
        'AKIA' + 'IOSFODNN7EXAMPLE', 'xox' + 'b-1234567890-abcdefghij', 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
        'cf_' + 'nt_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 'cf_' + 'at_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 'cf_' + 'rt_' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
        '-----BEGIN RSA ' + 'PRIVATE KEY-----', 'Authorization: Bearer ' + 'abcd1234efgh5678ijkl9012', 'https://user:' + 'hunter2@example.com/repo.git',
      ];
      for (const s of secrets) {
        expect(refuse(request({ brief: `use ${s} to push` })), s).toMatch(/^The request.brief holds something shaped like a credential/);
      }
      expect(refuse(request({ profile: secrets[0] }))).toMatch(/profile/);
      expect(refuse(request({ nodes: ['ok', secrets[3]] }))).toMatch(/nodes\[1\]/);
      expect(refuse(request({ refs: { proposal: secrets[0] } }))).toMatch(/refs\.proposal/);
    });
    it('does not mistake prose for a credential', () => {
      expect(c.validateRequest(request({ brief: 'Rotate the token handling in server/auth.js; see https://example.com/docs. Use sk for short, and ghp is a prefix.' })).ok).toBe(true);
      // Words that hold a prefix, and long hyphenated words after one: the detectors want a token's start and a token's digits
      for (const brief of [
        'Fix the desk-booking-service-for-small-teams page', 'Move the risk-assessment-workflow-for-reviewers', 'Ask-for-a-password-reset-flow-in-the-settings',
        'Add Bearer authentication-for-the-internal-gateway', 'Explain how the bearer token-refresh-and-rotation-logic works',
        'Never store the API token, the client secret or a password in the config; the runner uses its own credentials.',
        'Clone git@github.com:owner/repo.git, and read https://example.org/a?b=c#d', 'Compare http://localhost:8080/health with https://x.example:443/',
        'Rename masks-and-filters-in-the-explorer-panel', 'The sk-learn-compatible-transformers-and-estimators section', 'AKIA is the prefix of an AWS key id',
      ]) expect(c.validateRequest(request({ brief })).ok, brief).toBe(true);
    });
    it('reads a long brief or note in linear time, whatever it holds', () => {
      // Shapes that made the old patterns quadratic: one long word, a scheme followed by colons, a run of prefixes
      for (const s of ['a'.repeat(20000), `x://${':'.repeat(19990)}`, `x://${'a:'.repeat(9990)}`, 'sk-'.repeat(6600), 'Bearer '.repeat(2800), 'eyJ'.repeat(6600), `${'a'.repeat(19000)}://`]) {
        const t = performance.now();
        c.validateRequest(request({ brief: s.slice(0, c.MAX_BRIEF_CHARS) }));
        c.validateReport({ state: 'working', note: s.slice(0, c.MAX_NOTE_CHARS) });
        expect(performance.now() - t, s.slice(0, 12)).toBeLessThan(150);
      }
    });
  });
});

describe('createRequest', () => {
  it('writes the run id and the time, then checks', () => {
    const r = c.createRequest({ kind: 'code', refs: { issue: 12 }, brief: 'Fix it.', requestedBy: 'maintainer-one' }, { now: () => Date.UTC(2026, 10, 5, 9, 30, 0, 456), random: () => new Uint8Array(10).fill(1) });
    expect(r.ok).toBe(true);
    expect(r.value.requestedAt).toBe('2026-11-05T09:30:00Z');
    expect(c.runIdTime(r.value.runId).getTime()).toBe(Date.UTC(2026, 10, 5, 9, 30, 0, 456));
    expect(r.value.version).toBe(1);
  });
  it('refuses what is not its to set, and bad fields', () => {
    expect(c.createRequest({ kind: 'code', refs: { issue: 1 }, requestedBy: 'a', runId: ID }).error).toMatch(/does not set/);
    expect(c.createRequest({ kind: 'nope', refs: { issue: 1 }, requestedBy: 'a' }).error).toMatch(/"kind"/);
    expect(c.createRequest({ kind: 'code', refs: { issue: 1 }, requestedBy: 'a', profile: 'x' }, { profiles: ['y'] }).error).toMatch(/configured profiles/);
    expect(c.createRequest(null).ok).toBe(false);
    expect(c.createRequest({ kind: 'code', refs: { issue: 1 }, requestedBy: 'a' }, { now: () => NaN }).ok).toBe(false);
  });
});

describe('validateReport', () => {
  it('takes each state and every field', () => {
    for (const state of c.REPORT_STATES) expect(c.validateReport({ state })).toEqual({ ok: true, value: { state } });
    const all = { state: 'working', note: 'tests failing on auth, retrying', url: 'https://ci.example.com/runs/42?page=2#top', tokens: 12000, cost: 0.42 };
    expect(c.validateReport(all)).toEqual({ ok: true, value: all });
    expect(c.validateReport({ state: 'done', tokens: 0, cost: 0 }).ok).toBe(true);
  });
  it('refuses by name', () => {
    const no = (b) => c.validateReport(b).error;
    expect(no(null)).toMatch(/JSON object/);
    expect(no({})).toBe(`"state" is one of ${c.REPORT_STATES.join(', ')}.`);
    expect(no({ state: 'stop-requested' })).toMatch(/"state" is one of/);
    expect(no({ state: 'running' })).toMatch(/"state"/);
    expect(no({ state: 'done', extra: 1 })).toBe('A report has "extra", which the contract does not have.');
    expect(no({ state: 'done', note: 4 })).toBe('"note" is text.');
    expect(no({ state: 'done', note: 'x'.repeat(4001) })).toMatch(/"note" is at most 4000/);
    for (const url of ['ftp://x.example/a', 'javascript:alert(1)', 'https://u@host/x', 'not a url', '', 'https://x.example/ a', 5]) expect(no({ state: 'done', url }), String(url)).toMatch(/^"url" is an http/);
    expect(no({ state: 'done', url: 'https://u:p@host/x' })).toMatch(/shaped like a credential/);
    expect(no({ state: 'done', url: 'https://x.example/' + 'a'.repeat(2000) })).toMatch(/"url"/);
    for (const url of ['https://x.example/l?token=abc', 'https://x.example/l?a=1&api_key=abc', 'https://x.example/l?X-Amz-Signature=abc', 'https://x.example/l#access_token=abc', 'https://x.example/l?key=abc']) expect(no({ state: 'done', url }), url).toMatch(/credential in its query/);
    for (const tokens of [-1, 1.5, '3', NaN, 2 ** 60]) expect(no({ state: 'done', tokens })).toBe('"tokens" is a whole number, zero or more.');
    for (const cost of [-0.1, '1', NaN, Infinity]) expect(no({ state: 'done', cost })).toBe('"cost" is a number, zero or more.');
  });
  it('accepts tokens as a count but refuses a credential field', () => {
    expect(c.validateReport({ state: 'done', tokens: 5 }).ok).toBe(true);
    expect(c.validateReport({ state: 'done', token: 'x' }).error).toMatch(/^A report has "token", which looks like a credential/);
    expect(c.validateReport({ state: 'done', note: 'pushed with ghp_' + 'a'.repeat(36) }).error).toMatch(/report.note holds something shaped like a credential/);
    expect(c.validateReport({ state: 'done', note: 'see the token count above' }).ok).toBe(true);
  });
});

describe('validateStopRequest', () => {
  it('is stop-requested and a note', () => {
    expect(c.validateStopRequest({ state: 'stop-requested' })).toEqual({ ok: true, value: { state: 'stop-requested' } });
    expect(c.validateStopRequest({ state: 'stop-requested', note: 'wrong branch' })).toEqual({ ok: true, value: { state: 'stop-requested', note: 'wrong branch' } });
    expect(c.validateStopRequest({ state: 'done' }).error).toBe('"state" is "stop-requested".');
    expect(c.validateStopRequest({ state: 'stop-requested', url: 'https://x.example' }).error).toMatch(/"url", which the contract does not have/);
    expect(c.validateStopRequest({ state: 'stop-requested', note: 3 }).error).toBe('"note" is text.');
    expect(c.validateStopRequest([]).error).toMatch(/JSON object/);
    expect(c.validateStopRequest({ state: 'stop-requested', apiKey: 'x' }).error).toMatch(/credential/);
  });
});

describe('the waiting state and the answer (issue #101)', () => {
  it('takes waiting as a report state with a note and a link, and refuses a state it does not know', () => {
    expect(c.REPORT_STATES).toContain('waiting');
    const waiting = { state: 'waiting', note: 'Plan ready, approve to build', url: 'https://plans.example.com/42' };
    expect(c.validateReport(waiting)).toEqual({ ok: true, value: waiting });
    expect(c.validateReport({ state: 'paused' }).error).toMatch(/"state" is one of .*waiting/);
    expect(c.validateRunBody(waiting).type).toBe('report');
  });
  it('is answered, an action, and a text that a reply must have', () => {
    expect(c.validateAnswer({ state: 'answered', action: 'continue' })).toEqual({ ok: true, value: { state: 'answered', action: 'continue' } });
    expect(c.validateAnswer({ state: 'answered', action: 'stop', text: 'wrong branch' }).value).toEqual({ state: 'answered', action: 'stop', text: 'wrong branch' });
    expect(c.validateAnswer({ state: 'answered', action: 'reply', text: 'Use the second plan.' }).ok).toBe(true);
    expect(c.validateAnswer({ state: 'answered', action: 'reply' }).error).toMatch(/A reply has "text"/);
    expect(c.validateAnswer({ state: 'answered', action: 'reply', text: '   ' }).error).toMatch(/A reply has "text"/);
    expect(c.validateAnswer({ state: 'answered', action: 'approve' }).error).toBe('"action" is one of continue, stop, reply.');
    expect(c.validateAnswer({ state: 'done', action: 'continue' }).error).toBe('"state" is "answered".');
    expect(c.validateAnswer({ state: 'answered', action: 'continue', note: 'x' }).error).toMatch(/"note", which the contract does not have/);
    expect(c.validateAnswer({ state: 'answered', action: 'reply', text: 3 }).error).toBe('"text" is text.');
    expect(c.validateAnswer({ state: 'answered', action: 'continue', token: 'x' }).error).toMatch(/credential/);
    expect(c.validateAnswer({ state: 'answered', action: 'reply', text: 'use ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' }).ok).toBe(false);
    expect(c.validateAnswer([]).error).toMatch(/JSON object/);
    expect(c.validateRunBody({ state: 'answered', action: 'continue' }).type).toBe('answer');
  });
  it('round-trips as a block, with the reply in the block only', () => {
    for (const answer of [{ state: 'answered', action: 'continue' }, { state: 'answered', action: 'stop' }, { state: 'answered', action: 'reply', text: 'Use plan B.\n@everyone #1' }]) {
      const text = c.formatRunComment(ID, answer);
      expect(c.parseRunBlocks(text)).toEqual([{ runId: ID, type: 'answer', value: answer }]);
      expect(text.startsWith(`Answered run \`${ID}\`: ${answer.action}.`)).toBe(true);
    }
    // The reply's words are in the block only, never quoted beside it
    const replied = c.formatRunComment(ID, { state: 'answered', action: 'reply', text: 'Use plan B' });
    expect(replied).not.toContain('> Use plan B');
    expect(replied.split('Use plan B')).toHaveLength(2);
    expect(() => c.formatRunBlock(ID, { state: 'answered', action: 'reply' })).toThrow(/A reply has/);
  });
  it('is read from a comment, and an answer with a stray key is refused with the reason', () => {
    const bad = c.readRunBlocks(fenced(ID, { state: 'answered', action: 'continue', who: 'me' }));
    expect(bad.blocks).toEqual([]);
    expect(bad.refused[0].error).toMatch(/"who", which the contract does not have/);
    expect(c.latestBlock(c.parseRunBlocks(`${fenced(ID, { state: 'answered', action: 'continue' })}\n${fenced(ID, { state: 'answered', action: 'stop' })}`), ID, 'answer').value.action).toBe('stop');
  });
});

describe('validateRunBody', () => {
  it('picks the shape', () => {
    expect(c.validateRunBody(request()).type).toBe('request');
    expect(c.validateRunBody({ state: 'done' }).type).toBe('report');
    expect(c.validateRunBody({ state: 'stop-requested' }).type).toBe('stop-request');
    expect(c.validateRunBody([]).error).toMatch(/not a list/);
    expect(c.validateRunBody('x').error).toMatch(/one JSON object/);
    expect(c.validateRunBody({ token: 'x' }).error).toMatch(/looks like a credential/);
    expect(c.validateRunBody({}).error).toMatch(/"version" is 1/);
    expect(c.validateRunBody({ state: 'working', version: 1 }).ok).toBe(false);
  });
});

describe('the block', () => {
  it('round-trips a request, every report state and a stop request', () => {
    const r = full();
    const text = c.formatRunComment(ID, r);
    expect(c.parseRunBlocks(text)).toEqual([{ runId: ID, type: 'request', value: r }]);
    for (const state of c.REPORT_STATES) {
      const report = { state, note: 'line one\nline two', url: 'https://ci.example.com/42', tokens: 10, cost: 0.5 };
      expect(c.parseRunBlocks(c.formatRunComment(ID, report))).toEqual([{ runId: ID, type: 'report', value: report }]);
    }
    const stop = { state: 'stop-requested', note: 'wrong branch' };
    expect(c.parseRunBlocks(c.formatRunComment(ID, stop))).toEqual([{ runId: ID, type: 'stop-request', value: stop }]);
  });
  it('round-trips a hostile brief, one that tries to close the fence and open another', () => {
    const brief = 'done\n```\n```cornfield-run ' + ID2 + '\n{"state":"done"}\n```\n@everyone #1 https://x.example';
    const text = c.formatRunComment(ID, request({ brief }));
    const blocks = c.parseRunBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].value.brief).toBe(brief);
  });
  it('is the documented layout', () => {
    expect(c.formatRunBlock(ID, request())).toBe(`\`\`\`cornfield-run ${ID}\n${JSON.stringify(request(), null, 2)}\n\`\`\``);
    const text = c.formatRunComment(ID, request({ refs: { issue: 12 }, profile: 'claude' }));
    expect(text.startsWith(`Asked for a code run \`${ID}\` on issue #${ZW}12 with the profile claude (maintainer-one, in cornfield).\n\n\`\`\`cornfield-run ${ID}\n{`)).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
  });
  it('defuses the human line and the quoted note, but not the block', () => {
    const line = c.formatRunComment(ID, request({ refs: { issue: 12, thread: 3, proposal: 'p-1' }, requestedBy: 'maint' }));
    expect(line.split('\n')[0]).toBe(`Asked for a code run \`${ID}\` on issue #${ZW}12, proposal p-1, thread #${ZW}3 (maint, in cornfield).`);
    const report = c.formatRunComment(ID, { state: 'working', note: 'ping @bob and @org/team, see #5 and https://evil.example\n\nnext' });
    const [head, ...rest] = report.split('\n```cornfield-run')[0].split('\n');
    expect(head).toBe(`Run \`${ID}\`: working.`);
    const quoted = rest.join('\n');
    expect(quoted).toContain(`> ping @${ZW}bob and @${ZW}org/team, see #${ZW}5 and https:${ZW}//evil.example\n>\n> next`);
    expect(quoted).not.toMatch(/@bob|#5|:\/\//);
    // The block keeps the note as sent, for the runner
    expect(c.parseRunBlocks(report)[0].value.note).toContain('@bob and @org/team');
  });
  it('lets a caller word the line, on one line, defused and unable to open a fence', () => {
    const text = c.formatRunComment(ID, request(), { line: 'Hello @bob\n```cornfield-run ' + ID2 + '\n{"state":"done"}\n```' });
    expect(text.split('\n\n')[0]).not.toContain('\n');
    expect(text).toContain(`@${ZW}bob`);
    expect(c.parseRunBlocks(text)).toHaveLength(1);
    expect(c.parseRunBlocks(text)[0].runId).toBe(ID);
  });
  it('a quoted note cannot hold a block either', () => {
    const text = c.formatRunComment(ID, { state: 'done', note: '```cornfield-run ' + ID2 + '\n{"state":"failed"}\n```' });
    expect(c.parseRunBlocks(text)).toEqual([{ runId: ID, type: 'report', value: { state: 'done', note: '```cornfield-run ' + ID2 + '\n{"state":"failed"}\n```' } }]);
  });
  it('refuses to write what the contract refuses', () => {
    expect(() => c.formatRunBlock('nope', request())).toThrow(/not a run id/);
    expect(() => c.formatRunBlock(ID2, request())).toThrow(`The block is for ${ID2} but the request is for ${ID}.`);
    expect(() => c.formatRunBlock(ID, request({ kind: 'x' }))).toThrow(/"kind"/);
    expect(() => c.formatRunComment(ID, { state: 'done', token: 'x' })).toThrow(/credential/);
    expect(() => c.formatRunComment(ID, request({ brief: '\u0000'.repeat(c.MAX_BRIEF_CHARS) }))).toThrow(RangeError);
    expect(() => c.formatRunComment(ID, request({ profile: 'x' }), { profiles: ['y'] })).toThrow(/configured profiles/);
  });
  it('finds blocks among other text and many comments of them', () => {
    const text = `Some words first.\r\n\r\n${fenced(ID, request())}\r\n\r\nthanks!\n\n${fenced(ID, { state: 'claimed' })}\n\n${fenced(ID, { state: 'stop-requested' })}\ntrailing`;
    const blocks = c.parseRunBlocks(text);
    expect(blocks.map((b) => b.type)).toEqual(['request', 'report', 'stop-request']);
    expect(c.latestBlock(blocks, ID, 'report').value.state).toBe('claimed');
    expect(c.latestBlock(blocks, ID2, 'report')).toBeNull();
    const two = c.parseRunBlocks(`${fenced(ID, { state: 'working' })}\n${fenced(ID, { state: 'done' })}`);
    expect(c.latestBlock(two, ID, 'report').value.state).toBe('done');
  });
  it('ignores quoted, indented and fence-less lookalikes', () => {
    const q = fenced(ID, { state: 'done' });
    expect(c.parseRunBlocks(q.split('\n').map((l) => `> ${l}`).join('\n'))).toEqual([]);
    expect(c.parseRunBlocks(q.split('\n').map((l) => `  ${l}`).join('\n'))).toEqual([]);
    expect(c.parseRunBlocks('cornfield-run ' + ID)).toEqual([]);
    expect(c.parseRunBlocks('```json\n{"state":"done"}\n```')).toEqual([]);
    for (const x of [null, undefined, 3, {}, '']) expect(c.parseRunBlocks(x)).toEqual([]);
  });
  it('refuses a block by name, and says why', () => {
    const read = (s) => c.readRunBlocks(s);
    expect(read(fenced(ID, 'not json')).refused).toEqual([{ runId: ID, error: 'The block is not JSON (it holds exactly one object).' }]);
    expect(read(fenced(ID, '{"state":"done"}\n{"state":"failed"}')).refused[0].error).toMatch(/not JSON/);
    expect(read(fenced(ID, '[{"state":"done"}]')).refused[0].error).toBe('A cornfield-run block holds one JSON object, not a list.');
    expect(read(fenced(ID, '{"state":"done","extra":1}')).refused[0].error).toBe('A report has "extra", which the contract does not have.');
    expect(read(fenced(ID, { state: 'done', apiKey: 'x' })).refused[0].error).toMatch(/credential/);
    expect(read(fenced(ID, '"just a string"')).refused[0].error).toMatch(/one JSON object/);
    expect(read(fenced(ID2, request())).refused[0]).toEqual({ runId: ID2, error: `The fence is for ${ID2} but the request is for ${ID}.` });
    expect(read(fenced(ID, request({ kind: 'x' }))).refused[0].error).toMatch(/"kind"/);
    const nameless = read('```cornfield-run\n{"state":"done"}\n```');
    expect(nameless.refused[0]).toEqual({ runId: null, error: 'The fence names "", which is not a run id; it is `cornfield-run run-` and a 26 character ULID.' });
    expect(read(fenced('run-123', { state: 'done' })).refused[0].error).toMatch(/"run-123"/);
    expect(read(fenced(ID + ' extra', { state: 'done' })).refused[0].runId).toBeNull();
    expect(read(fenced(ID, { state: 'done' })).blocks).toHaveLength(1);
    // one bad block does not hide the good one beside it
    const mixed = read(`${fenced(ID, 'bad')}\n${fenced(ID, { state: 'done' })}`);
    expect(mixed.blocks).toHaveLength(1);
    expect(mixed.refused).toHaveLength(1);
    expect(c.parseRunBlocks(fenced(ID, 'bad'))).toEqual([]);
  });
  it('passes the profile list on', () => {
    expect(c.parseRunBlocks(fenced(ID, request({ profile: 'gpt' })), { profiles: ['claude'] })).toEqual([]);
    expect(c.readRunBlocks(fenced(ID, request({ profile: 'gpt' })), { profiles: ['claude'] }).refused[0].error).toMatch(/configured profiles/);
    expect(c.parseRunBlocks(fenced(ID, request({ profile: 'claude' })), { profiles: ['claude'] })).toHaveLength(1);
  });
  it('has caps', () => {
    const huge = fenced(ID, `{"state":"done","note":"${'x'.repeat(c.MAX_BLOCK_CHARS)}"}`);
    expect(c.readRunBlocks(huge).refused[0].error).toMatch(/longer than 60000/);
    const many = Array.from({ length: c.MAX_BLOCKS + 5 }, () => fenced(ID, { state: 'working' })).join('\n');
    const r = c.readRunBlocks(many);
    expect(r.blocks).toHaveLength(c.MAX_BLOCKS);
    expect(r.refused[0].error).toMatch(/at most 20/);
    expect(c.readRunBlocks(' '.repeat(c.MAX_TEXT_CHARS) + fenced(ID, { state: 'done' })).blocks).toEqual([]);
  });
});

describe('the trailer', () => {
  it('is written and read back', () => {
    expect(c.formatTrailer(ID)).toBe(`Cornfield-Run: ${ID}`);
    expect(c.parseTrailer(c.formatTrailer(ID))).toBe(ID);
    expect(() => c.formatTrailer('x')).toThrow(/not a run id/);
  });
  it('is found in a pull request body or a commit message', () => {
    expect(c.parseTrailer(`Fix the login.\n\nCloses #12\nCornfield-Run: ${ID}\n`)).toBe(ID);
    expect(c.parseTrailer(`feat: x\n\nbody\n\nSigned-off-by: a <a@b.c>\nCornfield-Run: ${ID}\r\nCo-Authored-By: x`)).toBe(ID);
    expect(c.parseTrailer(`  Cornfield-Run:   ${ID}   `)).toBe(ID);
  });
  it('takes the key in any case', () => {
    for (const key of ['cornfield-run', 'CORNFIELD-RUN', 'Cornfield-run', 'cornfield-Run']) expect(c.parseTrailer(`${key}: ${ID}`)).toBe(ID);
    expect(c.parseTrailer(`Cornfield-Run:${ID}`)).toBe(ID);
  });
  it('takes the last when there are several', () => {
    expect(c.parseTrailer(`Cornfield-Run: ${ID}\nmore\nCornfield-Run: ${ID2}`)).toBe(ID2);
  });
  it('must be the id alone on its line', () => {
    for (const t of [`> Cornfield-Run: ${ID}`, `see Cornfield-Run: ${ID}`, `Cornfield-Run: ${ID} and more`, `Cornfield-Run: ${ID}x`, `Cornfield-Run: ${ID.toLowerCase()}`, 'Cornfield-Run: run-123', 'Cornfield-Run:', `Cornfield Run: ${ID}`, `X-Cornfield-Run: ${ID}`, '']) expect(c.parseTrailer(t), t).toBeNull();
    for (const x of [null, undefined, 5, {}]) expect(c.parseTrailer(x)).toBeNull();
  });
});

describe('the branch fallback', () => {
  it('finds the id as a whole segment', () => {
    for (const b of [ID, `agent/${ID}`, `agent/${ID}/fix-auth`, `cornfield-${ID}`, `fix-${ID}-retry`, `${ID}.patch`]) expect(c.runIdFromBranch(b), b).toBe(ID);
  });
  it('forgives lower case and returns the id as minted', () => {
    expect(c.runIdFromBranch(`agent/${ID.toLowerCase()}`)).toBe(ID);
    expect(c.runIdFromBranch(`Agent/${ID.replace('run-', 'RUN-')}`)).toBe(ID);
  });
  it('does not find part of a longer word', () => {
    for (const b of [`xrun-${ID.slice(4)}`, `${ID}0`, `${ID}A`, `${ID.slice(0, -1)}`, 'run-123', 'main', 'agent/fix', '', `prerun-${ID.slice(4)}`]) expect(c.runIdFromBranch(b), b).toBeNull();
    for (const x of [null, undefined, 4]) expect(c.runIdFromBranch(x)).toBeNull();
  });
  it('takes the last of several', () => {
    expect(c.runIdFromBranch(`${ID}/${ID2}`)).toBe(ID2);
  });
});

describe('findRunId', () => {
  it('prefers the body trailer, then the latest commit trailer, then the branch', () => {
    const t = (id) => `msg\n\nCornfield-Run: ${id}`;
    expect(c.findRunId({ body: t(ID), commits: [t(ID2)], branch: `a/${ID2}` })).toEqual({ runId: ID, via: 'body' });
    expect(c.findRunId({ body: 'no trailer', commits: [t(ID), 'plain', t(ID2), 'plain again'], branch: 'x' })).toEqual({ runId: ID2, via: 'commit' });
    expect(c.findRunId({ body: '', commits: ['plain'], branch: `agent/${ID}` })).toEqual({ runId: ID, via: 'branch' });
    expect(c.findRunId({ branch: 'main' })).toBeNull();
    expect(c.findRunId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
//  The JSON Schema: a small checker for exactly the keywords the schema uses, then the same corpus put to both
// ---------------------------------------------------------------------------

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../../core/agent-contract.schema.json', import.meta.url), 'utf8'));

/** Draft 2020-12, only what agent-contract.schema.json uses: any keyword it does not know throws, so the schema cannot outgrow the checker unseen */
const KNOWN = new Set(['anyOf', 'dependentRequired', '$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'items', 'maxItems', 'properties', 'required', 'additionalProperties', 'minProperties', 'propertyNames', 'not', 'allOf', 'oneOf']);
function check(schema, value, root = SCHEMA) {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`the test checker does not know "${k}"`);
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o[k], root);
    if (!check(target, value, root)) return false;
  }
  const isObj = value !== null && typeof value === 'object' && !Array.isArray(value);
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const ok = { string: typeof value === 'string', object: isObj, array: Array.isArray(value), number: typeof value === 'number' && Number.isFinite(value), integer: Number.isInteger(value) }[schema.type];
    if (!ok) return false;
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) return false;
    if (schema.maxLength !== undefined && len > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((v) => check(schema.items, v, root))) return false;
  }
  if (isObj) {
    const keys = Object.keys(value);
    if ((schema.required ?? []).some((k) => !(k in value))) return false;
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) return false;
    for (const [k, needs] of Object.entries(schema.dependentRequired ?? {})) if (k in value && needs.some((n) => !(n in value))) return false;
    if (schema.propertyNames && !keys.every((k) => check(schema.propertyNames, k, root))) return false;
    for (const k of keys) {
      if (schema.properties?.[k]) {
        if (!check(schema.properties[k], value[k], root)) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }
  if (schema.not && check(schema.not, value, root)) return false;
  if (schema.allOf && !schema.allOf.every((s) => check(s, value, root))) return false;
  if (schema.oneOf && schema.oneOf.filter((s) => check(s, value, root)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((s) => check(s, value, root))) return false;
  return true;
}
const valid = (v) => check(SCHEMA, v);

const GOOD = [
  request(), full(),
  request({ kind: 'summary', refs: { thread: 7 } }), request({ kind: 'proposal', refs: { proposal: 'x' } }), request({ kind: 'brief', brief: '' }), request({ refs: { proposal: '0014-planner', pull: 40 } }),
  request({ requestedAt: '2026-11-05T09:30:00.5Z' }), request({ branch: 'a/b.c-d_e' }), request({ limits: {} }), request({ nodes: [] }),
  request({ limits: { minutes: 0.1, turns: 1, cost: 1e-6 } }), request({ refs: { issue: 2147483647 } }), request({ brief: 'x'.repeat(c.MAX_BRIEF_CHARS) }),
  request({ brief: 'Rotate the token handling in server/auth.js' }), request({ requestedBy: 'x'.repeat(40) }),
  request({ trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' } }), request({ trigger: { event: 'build.opened', by: 'maintainer-one', ref: 'issue:12' } }), request({ trigger: { event: 'thread.message', by: 'maintainer-one', ref: 'comment:9001' } }),
  ...c.REPORT_STATES.map((state) => ({ state })),
  { state: 'working', note: 'n', url: 'https://ci.example.com/run/1?page=2', tokens: 0, cost: 0 }, { state: 'done', cost: 1.25, tokens: 99 },
  { state: 'stop-requested' }, { state: 'stop-requested', note: 'wrong branch' },
  { state: 'waiting', note: 'Plan ready, approve to build', url: 'https://plans.example.com/42' },
  { state: 'answered', action: 'continue' }, { state: 'answered', action: 'stop', text: 'wrong branch' }, { state: 'answered', action: 'reply', text: 'Use the second plan.' },
];
const BAD = [
  null, [], 'x', 3, {}, { version: 1 },
  request({ version: 2 }), request({ version: '1' }), request({ runId: 'run-1' }), request({ runId: ID.toLowerCase() }), request({ kind: 'build' }),
  request({ extra: 1 }), request({ refs: {} }), request({ refs: { pull: 40 } }), request({ refs: { issue: 1, pull: 40 } }), request({ refs: { proposal: 'x', pull: 0 } }), request({ brief: undefined }), request({ refs: { pr: 1 } }), request({ refs: { issue: 0 } }), request({ refs: { issue: 1.5 } }), request({ refs: { thread: '3' } }), request({ refs: { proposal: '../x' } }),
  request({ profile: '' }), request({ profile: '-x' }), request({ profile: 'a'.repeat(65) }),
  ...['', '-rf', '/abs', 'trail/', 'a//b', 'a..b', 'end.', '.hidden', 'a/.b', 'a.lock', 'a.lock/b', 'sp ace', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', 'x'.repeat(201)].map((branch) => request({ branch })),
  request({ brief: 'x'.repeat(c.MAX_BRIEF_CHARS + 1) }), request({ brief: 3 }),
  request({ limits: { minutes: 0 } }), request({ limits: { turns: 2.5 } }), request({ limits: { cost: -1 } }), request({ limits: { hours: 1 } }), request({ limits: { minutes: '5' } }),
  request({ nodes: 'a' }), request({ nodes: [' x'] }), request({ nodes: [3] }), request({ nodes: Array.from({ length: 101 }, (_, i) => `n${i}`) }),
  request({ trigger: 'spec.approved' }), request({ trigger: {} }), request({ trigger: [] }), request({ trigger: { event: 'spec.approved', by: 'maintainer-one' } }),
  request({ trigger: { event: 'run.finished', by: 'maintainer-one', ref: 'pull:40' } }), request({ trigger: { event: 'spec.ready', by: 'maintainer-one', ref: 'pull:40' } }),
  request({ trigger: { event: 'spec.approved', by: 'a b', ref: 'pull:40' } }), request({ trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:x' } }), request({ trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'run:40' } }),
  request({ trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40', extra: 1 } }), request({ trigger: { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40', token: 'x' } }),
  request({ requestedBy: '' }), request({ requestedBy: 'a b' }), request({ requestedBy: 'x'.repeat(41) }), request({ requestedAt: '2026-11-05' }), request({ requestedAt: '2026-11-05T09:30:00+01:00' }),
  ...['token', 'githubToken', 'api_key', 'apiKey', 'secret', 'password', 'credentials', 'authorization', 'cookie', 'private_key'].map((k) => request({ [k]: 'x' })),
  ...['ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', 'AKIA' + 'IOSFODNN7EXAMPLE', '-----BEGIN ' + 'PRIVATE KEY-----', 'https://user:' + 'hunter2@example.com/x'].flatMap((s) => [request({ brief: `use ${s}` }), { state: 'done', note: s }]),
  { state: 'running' }, { state: 'stop-requested', url: 'https://x.example' }, { state: 'done', extra: 1 }, { state: 'done', note: 3 }, { state: 'done', note: 'x'.repeat(4001) },
  ...['ftp://x.example/a', 'javascript:alert(1)', 'https://u:p@host/x', 'https://u@host/x', 'not a url', '', 'https://x.example/ a', 'https://x.example/l?token=abc', 'https://x.example/l?api_key=abc', 'https://x.example/l#access_token=abc', 'https://x.example/l?key=abc'].map((url) => ({ state: 'done', url })),
  { state: 'done', tokens: -1 }, { state: 'done', tokens: 1.5 }, { state: 'done', tokens: '3' }, { state: 'done', cost: -1 }, { state: 'done', cost: '1' }, { state: 'done', token: 'x' },
  { state: 'stop-requested', note: 'x'.repeat(4001) }, { state: 'stop-requested', apiKey: 'x' },
  { state: 'waiting', note: 3 }, { state: 'waiting', extra: 1 }, { state: 'paused' },
  { state: 'answered' }, { state: 'answered', action: 'approve' }, { state: 'answered', action: 'reply', note: 'x' }, { state: 'answered', action: 'reply', text: 3 },
  { state: 'answered', action: 'reply', text: 'x'.repeat(4001) }, { state: 'answered', action: 'continue', apiKey: 'x' }, { state: 'answered', action: 'continue', url: 'https://x.example' },
  { ...request(), state: 'done' }, { state: 'claimed', version: 1 },
];

describe('the JSON Schema', () => {
  it('is draft 2020-12 and parses as a plain JSON file', () => {
    expect(SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(SCHEMA.$defs).sort()).toEqual(['answer', 'report', 'request', 'runId', 'stopRequest']);
  });
  it('says what the module says: caps, patterns and enums', () => {
    const req = SCHEMA.$defs.request;
    expect(req.properties.version.const).toBe(c.CONTRACT_VERSION);
    expect(req.properties.kind.enum).toEqual(c.RUN_KINDS);
    expect(SCHEMA.$defs.report.properties.state.enum).toEqual(c.REPORT_STATES);
    expect(SCHEMA.$defs.stopRequest.properties.state.const).toBe(c.STOP_STATE);
    expect(SCHEMA.$defs.runId.pattern).toBe(c.RUN_ID_SOURCE);
    expect(req.properties.brief.maxLength).toBe(c.MAX_BRIEF_CHARS);
    expect(req.properties.nodes.maxItems).toBe(c.MAX_NODES);
    expect(req.properties.nodes.items.maxLength).toBe(c.MAX_NODE_CHARS);
    expect(req.properties.branch.maxLength).toBe(c.MAX_BRANCH_CHARS);
    expect(req.properties.requestedBy.pattern).toBe(c.LOGIN_SOURCE);
    expect(req.properties.requestedAt.pattern).toBe(c.ISO_SOURCE);
    expect(req.properties.trigger.properties.event.enum).toEqual(c.TRIGGER_EVENTS);
    expect(req.properties.trigger.properties.by.pattern).toBe(c.LOGIN_SOURCE);
    expect(req.properties.trigger.properties.ref.pattern).toBe(c.TRIGGER_REF_SOURCE);
    expect(req.properties.trigger.additionalProperties).toBe(false);
    expect(req.properties.trigger.required).toEqual(['event', 'by', 'ref']);
    expect(req.required).not.toContain('trigger');
    expect(req.propertyNames.not.pattern).toBe(c.CREDENTIAL_KEY_SOURCE);
    expect(req.properties.brief.not.pattern).toBe(c.CREDENTIAL_VALUE_SOURCE);
    expect(SCHEMA.$defs.report.properties.note.maxLength).toBe(c.MAX_NOTE_CHARS);
    expect(SCHEMA.$defs.report.properties.url.pattern).toBe(c.URL_SOURCE);
    expect(SCHEMA.$defs.report.properties.url.maxLength).toBe(c.MAX_URL_CHARS);
    expect(SCHEMA.$defs.report.properties.state.enum).not.toContain(c.STOP_STATE);
    // No property of any definition is left open
    expect(SCHEMA.$defs.answer.properties.state.const).toBe(c.ANSWER_STATE);
    expect(SCHEMA.$defs.answer.properties.action.enum).toEqual(c.ANSWER_ACTIONS);
    expect(SCHEMA.$defs.answer.properties.text.maxLength).toBe(c.MAX_NOTE_CHARS);
    expect(SCHEMA.$defs.report.properties.state.enum).toContain('waiting');
    for (const def of ['request', 'report', 'stopRequest', 'answer']) expect(SCHEMA.$defs[def].additionalProperties).toBe(false);
    expect(SCHEMA.$defs.request.properties.refs.additionalProperties).toBe(false);
    expect(SCHEMA.$defs.request.properties.limits.additionalProperties).toBe(false);
    // The request lists exactly the keys the validator allows
    expect(Object.keys(req.properties).sort()).toEqual(['branch', 'brief', 'kind', 'limits', 'nodes', 'profile', 'refs', 'requestedAt', 'requestedBy', 'runId', 'trigger', 'version']);
    expect(Object.keys(req.properties.refs.properties)).toEqual(['issue', 'proposal', 'pull', 'thread']);
    // What the spec's table does not mark optional is required
    expect(req.required).toEqual(['version', 'runId', 'kind', 'refs', 'brief', 'requestedBy', 'requestedAt']);
  });
  it('agrees with the validator on every good example', () => {
    for (const ex of GOOD) {
      const body = ex;
      const kind = 'version' in body ? c.validateRequest(body) : body.state === 'stop-requested' ? c.validateStopRequest(body) : body.state === 'answered' ? c.validateAnswer(body) : c.validateReport(body);
      expect(kind.ok, JSON.stringify(ex)).toBe(true);
      expect(valid(ex), JSON.stringify(ex)).toBe(true);
    }
  });
  it('agrees with the validator on every bad example', () => {
    for (const ex of BAD) {
      expect(c.validateRunBody(ex).ok, JSON.stringify(ex)).toBe(false);
      expect(valid(ex), JSON.stringify(ex)).toBe(false);
    }
  });
  it('agrees on a few thousand mutations of the good examples', () => {
    // Put each field of each good request through a set of odd values; the two must say the same thing wherever the schema speaks
    const odd = [undefined, null, 0, 1, -1, 1.5, '', 'x', ' ', true, [], {}, [1], { a: 1 }, 'run-1', 2 ** 60, 'a'.repeat(300)];
    let n = 0;
    for (const base of [full(), { state: 'working', note: 'n', url: 'https://x.example/', tokens: 1, cost: 1 }, { state: 'stop-requested', note: 'n' }, { state: 'answered', action: 'continue', text: 'n' }]) {
      for (const key of Object.keys(base)) {
        for (const o of odd) {
          const ex = { ...base };
          if (o === undefined) delete ex[key]; else ex[key] = o;
          const type = 'version' in ex || 'runId' in ex ? 'request' : ex.state === 'stop-requested' ? 'stop' : ex.state === 'answered' ? 'answer' : 'report';
          const ok = (type === 'request' ? c.validateRequest(ex) : type === 'stop' ? c.validateStopRequest(ex) : type === 'answer' ? c.validateAnswer(ex) : c.validateReport(ex)).ok;
          const schemaSays = type === 'request' ? check(SCHEMA.$defs.request, ex) : type === 'stop' ? check(SCHEMA.$defs.stopRequest, ex) : type === 'answer' ? check(SCHEMA.$defs.answer, ex) : check(SCHEMA.$defs.report, ex);
          expect(schemaSays, `${type} ${key}=${JSON.stringify(o)}`).toBe(ok);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(100);
  });
  it('is looser than the validator in exactly the documented ways', () => {
    // Rules a schema cannot hold: the developer's profile list, and a date that does not exist
    expect(c.validateRequest(request({ profile: 'gpt' }), { profiles: ['claude'] }).ok).toBe(false);
    expect(valid(request({ profile: 'gpt' }))).toBe(true);
    expect(c.validateRequest(request({ requestedAt: '2026-02-30T00:00:00Z' })).ok).toBe(false);
    expect(valid(request({ requestedAt: '2026-02-30T00:00:00Z' }))).toBe(true);
    // and a trigger that names someone else than the maintainer the request is made as
    const other = request({ trigger: { event: 'spec.approved', by: 'maintainer-two', ref: 'pull:40' } });
    expect(c.validateRequest(other).error).toMatch(/same login as "requestedBy"/);
    expect(valid(other)).toBe(true);
  });
  it('accepts what the module writes', () => {
    const made = c.createRequest({ kind: 'code', refs: { issue: 12 }, brief: 'Fix it.', requestedBy: 'maintainer-one', branch: 'agent/x', limits: { turns: 5 } }).value;
    expect(valid(made)).toBe(true);
    for (const b of c.parseRunBlocks(c.formatRunComment(made.runId, made))) expect(valid(b.value)).toBe(true);
  });
  it('the checker is not asleep: it rejects a schema keyword it does not know', () => {
    expect(() => check({ format: 'uri' }, 'x')).toThrow(/does not know/);
  });
});

describe('the trigger field (an automatic request names its cause)', () => {
  const trig = { event: 'spec.approved', by: 'maintainer-one', ref: 'pull:40' };
  it('is optional, kept in order and copied', () => {
    const r = c.validateRequest(request({ trigger: { ref: 'pull:40', by: 'maintainer-one', event: 'spec.approved' } }));
    expect(r.ok).toBe(true);
    expect(Object.keys(r.value.trigger)).toEqual(['event', 'by', 'ref']);
    expect(Object.keys(r.value).at(-1)).toBe('trigger');
    expect(c.validateRequest(request()).value.trigger).toBeUndefined();
  });
  it('is strict: three events, a login, a ref, nothing else, and never a credential', () => {
    expect(c.TRIGGER_EVENTS).toEqual(['spec.approved', 'build.opened', 'thread.message']);
    for (const bad of [null, 'x', [], {}, { ...trig, event: 'pr.landed' }, { ...trig, by: '' }, { ...trig, ref: 'pull' }, { ...trig, ref: 'pull:1.5' }, { ...trig, extra: 1 }, { ...trig, token: 'x' }]) {
      expect(refuse(request({ trigger: bad })), JSON.stringify(bad)).toMatch(/trigger/);
    }
    expect(refuse(request({ trigger: { ...trig, apiKey: 'x' } }))).toMatch(/credential/);
    expect(refuse(request({ trigger: { ...trig, by: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8' } }))).toMatch(/trigger\.by|credential/);
  });
  it('createRequest takes it, and the comment carries it back', () => {
    const made = c.createRequest({ kind: 'code', refs: { issue: 12 }, brief: '', requestedBy: 'maintainer-one', trigger: trig });
    expect(made.value.trigger).toEqual(trig);
    const [b] = c.parseRunBlocks(c.formatRunComment(made.value.runId, made.value));
    expect(b.value.trigger).toEqual(trig);
  });
});

describe('reading hostile text (lead review of #85)', () => {
  const req = () => request({ brief: 'Fix it.' });
  const block = fenced(ID, req());
  const ids = (text) => c.readRunBlocks(text).blocks.map((b) => b.runId);

  it('finds a block with Windows line ends, and not one in a quoted reply or an indented one', () => {
    expect(ids(`Asked.\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\n`)).toEqual([ID]);
    expect(ids(block.split('\n').map((l) => `> ${l}`).join('\n'))).toEqual([]);
    expect(ids(block.split('\n').map((l) => `    ${l}`).join('\n'))).toEqual([]);
  });
  it('does not read a block inside another fence: a ```` or ~~~ example, or a ```js block', () => {
    expect(ids(`An example:\n\n\`\`\`\`\n${block}\n\`\`\`\`\n`)).toEqual([]);
    expect(ids(`~~~\n${block}\n~~~`)).toEqual([]);
    expect(ids(`\`\`\`js\nconst s = \`\n${block}\n`)).toEqual([]);
    // and finds the real one after the example
    expect(ids(`\`\`\`\`markdown\n${fenced(ID2, request({ runId: ID2 }))}\n\`\`\`\`\n\n${block}`)).toEqual([ID]);
  });
  it('does not read a block nobody closed, and stays linear on a megabyte of unclosed fences', () => {
    expect(ids(`\`\`\`cornfield-run ${ID}\n${JSON.stringify(req())}`)).toEqual([]);
    const t = performance.now();
    expect(c.readRunBlocks(`\`\`\`cornfield-run x\n${'a'.repeat(10)}\n`.repeat(30000)).blocks).toEqual([]);
    expect(c.readRunBlocks(`\`\`\`cornfield-run ${ID}\n`.repeat(25000)).blocks).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1000);
  });
  it('is not fooled by a fence closed with a longer one, or a closing line that holds more', () => {
    expect(ids(`\`\`\`cornfield-run ${ID}\n${JSON.stringify(req())}\n\`\`\`\`\n`)).toEqual([ID]);
    expect(ids(`\`\`\`cornfield-run ${ID}\n${JSON.stringify(req())}\n\`\`\` trailing\n`)).toEqual([]);
  });
});

describe('the trailer in a pull request body (lead review of #85)', () => {
  it('does not count one inside a code block, or indented as code', () => {
    expect(c.parseTrailer(`How to use it:\n\n\`\`\`\nCornfield-Run: ${ID}\n\`\`\`\n`)).toBeNull();
    expect(c.parseTrailer(`~~~text\nCornfield-Run: ${ID}\n~~~`)).toBeNull();
    expect(c.parseTrailer(`\`\`\`\`\n\`\`\`\nCornfield-Run: ${ID}\n\`\`\`\n\`\`\`\``)).toBeNull();
    expect(c.parseTrailer(`Example:\n\n    Cornfield-Run: ${ID}\n`)).toBeNull();
    expect(c.parseTrailer(`\tCornfield-Run: ${ID}`)).toBeNull();
    // an unclosed fence runs to the end, as Markdown reads it
    expect(c.parseTrailer(`\`\`\`\nCornfield-Run: ${ID}`)).toBeNull();
  });
  it('counts the real one after an example, and the example does not win by coming last', () => {
    expect(c.parseTrailer(`Cornfield-Run: ${ID}\n\nLike this:\n\n\`\`\`\nCornfield-Run: ${ID2}\n\`\`\``)).toBe(ID);
    expect(c.findRunId({ body: `\`\`\`\nCornfield-Run: ${ID2}\n\`\`\``, commits: [`x\n\nCornfield-Run: ${ID}`] })).toEqual({ runId: ID, via: 'commit' });
  });
});

describe('refs.pull', () => {
  it('names the spec pull request of a proposal, and only with one', () => {
    expect(c.validateRequest(request({ refs: { proposal: '0014-planner', pull: 40 } })).value.refs).toEqual({ proposal: '0014-planner', pull: 40 });
    expect(c.validateRequest(request({ refs: { issue: 3, pull: 40 } })).error).toMatch(/comes with one/);
    expect(c.validateRequest(request({ refs: { pull: 40 } })).ok).toBe(false);
    const made = c.createRequest({ kind: 'code', refs: { proposal: '0014-planner', pull: 40 }, brief: '', requestedBy: 'maintainer-one' }).value;
    expect(c.formatRunComment(made.runId, made).split('\n')[0]).toContain(`proposal 0014-planner (pull request #${ZW}40)`);
  });
  it('the brief is required, and may be empty', () => {
    expect(c.validateRequest(request({ brief: undefined })).error).toMatch(/"brief" is the text/);
    expect(c.validateRequest(request({ brief: '' })).ok).toBe(true);
  });
});

describe('a forge conversation (runBlocksOf, runAuthors)', () => {
  const at = '2026-11-05T09:30:00Z';
  const later = '2026-11-05T09:40:00Z';
  const comment = (id, login, body, updatedAt = at) => ({ id, author: login ? { login } : null, body, url: `https://x.test/c/${id}`, createdAt: at, updatedAt });
  const ask = fenced(ID, request());
  const report = (state) => fenced(ID, { state });
  const comments = [
    comment(1, 'maintainer-one', `Asked.\n\n${ask}`),
    comment(2, 'drive-by', `Me too:\n\n${fenced(ID2, request({ runId: ID2 }))}`),
    comment(3, 'runner-bot', report('claimed')),
    comment(4, 'maintainer-one', report('working'), later), // edited after it was posted
    comment(5, null, report('done')), // a deleted account
    comment(6, 'runner-bot', fenced(ID, '{"state":"nope"}')),
    comment(7, 'someone', 'no blocks here, only the word cornfield-run'),
  ];
  const trusted = new Set(['maintainer-one', 'runner-bot']);

  it('keeps trusted, unedited blocks with where they came from, and sets the rest aside with the reason', () => {
    const r = c.runBlocksOf(comments, { trust: (login) => trusted.has(login) });
    expect(r.blocks.map((b) => [b.comment.id, b.by, b.type, b.runId])).toEqual([['1', 'maintainer-one', 'request', ID], ['3', 'runner-bot', 'report', ID]]);
    expect(r.blocks[0]).toMatchObject({ at, comment: { url: 'https://x.test/c/1' } });
    expect(r.ignored.map((b) => [b.comment.id, b.by, b.why])).toEqual([['2', 'drive-by', 'author'], ['4', 'maintainer-one', 'edited'], ['5', null, 'author']]);
    expect(r.refused.map((b) => [b.comment.id, b.by])).toEqual([['6', 'runner-bot']]);
    expect(c.latestBlock(r.blocks, ID, 'report').value).toEqual({ state: 'claimed' });
  });
  it('asks trust about each block, so a runner may report but not request', () => {
    const r = c.runBlocksOf(comments, { trust: (login, b) => login === 'maintainer-one' || (login === 'runner-bot' && b.type === 'report') });
    expect(r.blocks.map((b) => b.comment.id)).toEqual(['1', '3']);
    const r2 = c.runBlocksOf([comment(9, 'runner-bot', ask)], { trust: (login, b) => login === 'runner-bot' && b.type === 'report' });
    expect(r2.blocks).toEqual([]);
    expect(r2.ignored.map((b) => b.why)).toEqual(['author']);
  });
  it('names the authors worth asking about, newest first, once each', () => {
    expect(c.runAuthors(comments)).toEqual(['someone', 'runner-bot', 'maintainer-one', 'drive-by']);
    expect(c.runAuthors(null)).toEqual([]);
  });
  it('needs a trust function, and takes anything else quietly', () => {
    expect(() => c.runBlocksOf(comments)).toThrow(/trust/);
    expect(c.runBlocksOf(null, { trust: () => true })).toEqual({ blocks: [], ignored: [], refused: [] });
    expect(c.runBlocksOf([null, { body: 3 }], { trust: () => true })).toEqual({ blocks: [], ignored: [], refused: [] });
  });
});

describe('where it can be loaded', () => {
  it('imports nothing from server/ and nothing from node:, so the browser can load it too', () => {
    for (const f of ['../../core/agent-contract.js', '../../core/defuse.js']) {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/from ['"](node:|\.\.\/server\/)/);
    }
  });
});
