/**
 * @vitest-environment node
 *
 * The decision's words and choices (spec 0007 D1, D2, D3, D4), without a page: one test per row of the two tables, so each state says
 * what the line says, and whether Approve allows, asks or is refused. The page's half is review-decision-ui.test.js.
 */
import { describe, it, expect } from 'vitest';
import {
  HOLD_MS, LAND_MINUTES, decide, askReasons, askWords, newReasons, sendBackLine, sendBackDecision, refusalWords, runWords, runWaits, nameList,
  holdWords, holdStartWords, holdCancelledWords, editsSentWords,
} from '../../explorer/decision-model.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

/** The route's answer for PR `n`, with what a test changes */
const facts = (over = {}) => ({
  pull: { number: 23, draft: false, head: 'a'.repeat(40) },
  checks: { total: 2, passed: 2, running: 0, failed: [] },
  lands: false,
  landing: null,
  run: null,
  ...over,
});
const line = (f, extra = {}) => decide({ source: 'pull/23', facts: f, factsState: 'ready', now: NOW, ...extra });

describe('the line above Approve (D1)', () => {
  it('open, checks passed, landing off', () => {
    expect(line(facts()).line).toBe('Approve posts an approval on PR #23. It does not land it.');
  });
  it('open, checks passed, landing on', () => {
    expect(line(facts({ lands: true })).line).toBe('Approve posts an approval on PR #23 and lands it.');
  });
  it('open, 1 check running, landing off', () => {
    expect(line(facts({ checks: { total: 2, passed: 1, running: 1, failed: [] } })).line).toBe('Approve posts an approval on PR #23. 1 check is still running.');
  });
  it('open, checks running, landing on', () => {
    expect(line(facts({ lands: true, checks: { total: 2, passed: 1, running: 1, failed: [] } })).line).toBe('Approve posts an approval on PR #23. It lands once 1 running check passes.');
    expect(line(facts({ lands: true, checks: { total: 3, passed: 1, running: 2, failed: [] } })).line).toContain('It lands once 2 running checks pass.');
    expect(line(facts({ checks: { total: 3, passed: 1, running: 2, failed: [] } })).line).toContain('2 checks are still running.');
  });
  it('open, a check failed, landing off', () => {
    expect(line(facts({ checks: { total: 2, passed: 1, running: 0, failed: ['lint'] } })).line).toBe('Approve posts an approval on PR #23. lint failed.');
  });
  it('open, a check failed, landing on', () => {
    expect(line(facts({ lands: true, checks: { total: 2, passed: 1, running: 0, failed: ['lint'] } })).line).toBe('Approve posts an approval on PR #23. It will not land: lint failed.');
  });
  it('open, no checks, landing on (and off says it does not land)', () => {
    const none = { total: 0, passed: 0, running: 0, failed: [] };
    expect(line(facts({ lands: true, checks: none })).line).toBe('Approve posts an approval on PR #23. It will not land: the PR has no checks.');
    expect(line(facts({ checks: none })).line).toBe('Approve posts an approval on PR #23. It does not land it.');
  });
  it('open, every check skipped: landing on says no check has passed', () => {
    expect(line(facts({ lands: true, checks: { total: 2, passed: 0, running: 0, failed: [] } })).line).toBe('Approve posts an approval on PR #23. It will not land: no check has passed.');
  });
  it('a draft, landing off', () => {
    expect(line(facts({ pull: { number: 24, draft: true, head: 'b' } })).line).toBe('PR #24 is a draft. Approve posts an approval on it.');
  });
  it('a draft, landing on: it lands only if marked ready within the time the lander waits', () => {
    expect(line(facts({ lands: true, pull: { number: 24, draft: true, head: 'b' } })).line).toBe(`PR #24 is a draft. Approve posts an approval; it lands only if the PR is marked ready within ${LAND_MINUTES} minutes.`);
  });

  describe('the run an approval asks for', () => {
    const run = (over) => facts({ run: { kind: 'code', transport: 'pull', runner: 'online', lastSeen: ago(20_000), ...over } });
    it('is not mentioned when no trigger is set', () => {
      expect(line(facts()).line).not.toMatch(/run/);
    });
    it('with the runner online', () => {
      expect(line(run()).line).toBe('Approve posts an approval on PR #23. It does not land it. Then a code run is asked for. A runner is online.');
    });
    it('with the runner quiet: how long, and that the run will wait', () => {
      expect(runWords({ kind: 'code', transport: 'pull', runner: 'quiet', lastSeen: ago(2 * H) }, NOW)).toBe('Then a code run is asked for. No runner has polled for 2 h: the run will wait.');
      expect(runWords({ kind: 'code', transport: 'pull', runner: 'quiet', lastSeen: ago(5 * 60_000) }, NOW)).toContain('for 5 min:');
      // an approval now asks for no new run: one is open on the PR or the proposal, or one was asked for at this head (the trigger skips it)
      expect(runWords({ kind: 'code', transport: 'pull', runner: 'online', open: 'run-01ABC' }, NOW)).toBe('No new run is asked for: run run-01ABC is still open on it.');
      expect(runWords({ kind: 'code', transport: 'forge', runner: null, fired: true }, NOW)).toBe('No new run is asked for: a code run was asked for at this head already.');
    });
    it('with no runner ever seen', () => {
      expect(runWords({ kind: 'code', transport: 'pull', runner: 'never', lastSeen: null }, NOW)).toBe('Then a code run is asked for. No runner has polled yet: the run will wait.');
    });
    it('on the forge or push transport the request is posted for your runner', () => {
      for (const transport of ['forge', 'push']) expect(runWords({ kind: 'code', transport, runner: null, lastSeen: null }, NOW)).toBe('Then a code run is asked for. The request is posted for your runner.');
    });
    it('another kind of run is named by its kind, from the fixed list only', () => {
      expect(runWords({ kind: 'summary', transport: 'forge' }, NOW)).toContain('a summary run');
      expect(runWords({ kind: '<b>x</b>', transport: 'forge' }, NOW)).toContain('a code run'); // a value outside the list is never repeated
    });
    it('knows when a run would wait (the Work dot, the notices): only the pull transport, with the runner quiet or never seen', () => {
      expect(runWaits({ transport: 'pull', runner: 'quiet' })).toBe(true);
      expect(runWaits({ transport: 'pull', runner: 'never' })).toBe(true);
      expect(runWaits({ transport: 'pull', runner: 'online' })).toBe(false);
      expect(runWaits({ transport: 'forge', runner: null })).toBe(false);
      expect(runWaits(null)).toBe(false);
    });
  });

  it('the reviewer has what-if edits: they go in the comment', () => {
    expect(line(facts(), { edits: 2 }).line).toBe('Approve posts an approval on PR #23. It does not land it. Your 2 edits go in the comment, for the agent to fold in.');
    expect(line(facts(), { edits: 1 }).line).toContain('Your 1 edit goes in the comment');
  });

  it('keeps the count of scenarios played in the line (spec 0006)', () => {
    expect(line(facts(), { played: '2 of 3 scenarios played' }).line).toMatch(/2 of 3 scenarios played$/);
  });

  it('a draft in the checkout or a worktree has no PR: the line says to push it, and Approve is refused', () => {
    const a = decide({ source: 'checkout', facts: null, factsState: 'ready', now: NOW });
    expect(a).toMatchObject({ line: 'Draft in the checkout: push it as a spec PR to review it here.', approve: 'refused' });
    expect(decide({ source: 'w-0007', facts: null, factsState: 'ready', now: NOW }).line).toBe('Draft in worktree w-0007: push it as a spec PR to review it here.');
  });

  it('a PR whose state could not be read: the line says so, and Approve is still allowed', () => {
    const a = decide({ source: 'pull/23', facts: null, factsState: 'unread', now: NOW });
    expect(a).toMatchObject({ line: "Could not read PR #23's checks. Approve posts an approval on it.", approve: 'allowed' });
  });

  it('before the first answer the line reads the PR, and a press is not allowed to guess', () => {
    expect(decide({ source: 'pull/23', facts: null, factsState: 'loading', now: NOW })).toMatchObject({ line: 'Reading PR #23 …', approve: 'reading' });
  });

  it('names from the forge are text: cut to a length, never more than three spelled out', () => {
    expect(nameList(['lint'])).toBe('lint');
    expect(nameList(['lint', 'test'])).toBe('lint and test');
    expect(nameList(['a', 'b', 'c'])).toBe('a, b and c');
    expect(nameList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(nameList(['x'.repeat(100)])[0]).toBe('x');
    expect(nameList(['x'.repeat(100)]).length).toBeLessThanOrEqual(40);
    // a name is not markup here or anywhere: the page sets it with textContent, and this module never builds HTML
    expect(nameList(['<img src=x onerror=alert(1)>'])).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('when Approve allows, asks, or is refused (D2)', () => {
  const failedFacts = (over = {}) => facts({ checks: { total: 2, passed: 1, running: 0, failed: ['lint'] }, ...over });

  it('an open PR with checks passed or running: allowed, with the line alone', () => {
    expect(line(facts())).toMatchObject({ approve: 'allowed', ask: '' });
    expect(line(facts({ checks: { total: 2, passed: 1, running: 1, failed: [] } }))).toMatchObject({ approve: 'allowed', ask: '' });
  });
  it('checks failed: asks, with the words of the table', () => {
    expect(line(failedFacts())).toMatchObject({ approve: 'asks', ask: 'lint failed on PR #23. Approve anyway?' });
  });
  it('a draft: asks', () => {
    expect(line(facts({ pull: { number: 24, draft: true, head: 'b' } }))).toMatchObject({ approve: 'asks', ask: 'PR #24 is a draft: its author has not marked it ready. Approve anyway?' });
  });
  it('a what-if form that holds input: asks, naming the form', () => {
    expect(line(facts(), { form: { name: 'Add a node' } })).toMatchObject({ approve: 'asks', ask: 'Your Add a node form is not added. Approve without it?' });
  });
  it('edits, with landing on: asks; with landing off the line alone is enough', () => {
    expect(line(facts({ lands: true }), { edits: 2 })).toMatchObject({ approve: 'asks', ask: 'PR #23 lands as written; your 2 edits only go in the comment. Approve anyway?' });
    expect(line(facts({ lands: false }), { edits: 2 })).toMatchObject({ approve: 'allowed', ask: '' });
  });
  it('no runner online: allowed, the line says so', () => {
    const f = facts({ run: { kind: 'code', transport: 'pull', runner: 'never', lastSeen: null } });
    expect(line(f)).toMatchObject({ approve: 'allowed' });
    expect(line(f).line).toContain('the run will wait');
  });
  it('running checks do not ask (the lander already waits for them)', () => {
    expect(line(facts({ lands: true, checks: { total: 1, passed: 0, running: 1, failed: [] } })).approve).toBe('allowed');
  });
  it('already approved at this head: done, and a stale approval is not', () => {
    expect(line(facts(), { review: { verdict: 'approved', current: true } }).approve).toBe('done');
    expect(line(facts(), { review: { verdict: 'approved', current: true } }).line).toBe('An approval of this version of PR #23 stands. A push makes Approve live again.');
    expect(line(facts({ landing: { by: 'm', since: 'x' } }), { review: { verdict: 'approved', current: true } }).line).toBe('An approval of this version of PR #23 stands. Its landing waits for the checks. A push makes Approve live again.');
    expect(line(facts(), { review: { verdict: 'approved', current: false } }).approve).toBe('allowed');
    expect(line(facts(), { review: { verdict: 'notes' } }).approve).toBe('allowed');
    // reading again after the push: the approval no longer stands, and the facts say what to do now
    expect(decide({ source: 'pull/23', facts: null, factsState: 'unread', review: { verdict: 'approved', current: true }, now: NOW }).approve).toBe('done');
  });
  it('a draft in the checkout or a worktree: refused', () => {
    expect(decide({ source: 'w-1', facts: null, factsState: 'ready' }).approve).toBe('refused');
  });
  it('several reasons are said together, once, and end Approve anyway', () => {
    const f = failedFacts({ lands: true, pull: { number: 23, draft: true, head: 'a' } });
    const a = line(f, { edits: 1, form: { name: 'Draw an edge' } });
    expect(a.reasons.map((r) => r.key)).toEqual(['failed', 'draft', 'form', 'edits']);
    expect(a.ask.endsWith('Approve anyway?')).toBe(true);
    expect(a.ask).toContain('lint failed on PR #23.');
    expect(a.ask).toContain('Your Draw an edge form is not added.');
  });
  it('at the end of the hold only a reason not yet answered asks again', () => {
    const before = askReasons({ facts: failedFacts(), edits: 0, form: null });
    expect(newReasons(before, ['failed'])).toEqual([]);
    const after = askReasons({ facts: failedFacts({ pull: { number: 23, draft: true, head: 'a' } }), edits: 0, form: null });
    expect(newReasons(after, ['failed']).map((r) => r.key)).toEqual(['draft']);
    expect(askWords(newReasons(after, ['failed']))).toBe('PR #23 is a draft: its author has not marked it ready. Approve anyway?');
  });
});

describe('Send back (D4, D6)', () => {
  it('the line under the note says what is posted and that no run is asked for', () => {
    expect(sendBackLine({ source: 'pull/23', edits: 2 })).toBe('Posts your note and 2 edits on PR #23 for the drafting agent. No run is asked for.');
    expect(sendBackLine({ source: 'pull/23', edits: 1 })).toBe('Posts your note and 1 edit on PR #23 for the drafting agent. No run is asked for.');
    expect(sendBackLine({ source: 'pull/23', edits: 0 })).toBe('Posts your note on PR #23 for the drafting agent. No run is asked for.');
    expect(sendBackLine({ source: 'checkout', edits: 0 })).toBe('');
  });
  it('asks only for a form that holds input, as Approve does', () => {
    expect(sendBackDecision({ form: null })).toMatchObject({ asks: false, ask: '' });
    expect(sendBackDecision({ form: { name: 'Add a node' } })).toMatchObject({ asks: true, ask: 'Your Add a node form is not added. Send back without it?' });
  });
  it('says what was sent, readable afterwards', () => {
    expect(editsSentWords(2)).toBe('Sent with 2 edits');
    expect(editsSentWords(1)).toBe('Sent with 1 edit');
  });
});

describe('the server\'s refusals at the press, in words (D2)', () => {
  it('401: the sign-in has ended, and the edits are kept', () => {
    expect(refusalWords(401, 'Not signed in.')).toBe('Your sign-in has ended. Sign in again: your edits are kept here.');
  });
  it('403: the server\'s own words (no longer a maintainer)', () => {
    expect(refusalWords(403, 'maintainer-one no longer maintains this repo, so the forge would not count the review.')).toBe('maintainer-one no longer maintains this repo, so the forge would not count the review.');
  });
  it('409: what stands already; anything else says nothing was posted', () => {
    expect(refusalWords(409, 'x is already approved at this head.')).toBe('x is already approved at this head.');
    expect(refusalWords(502, 'The forge did not answer.')).toBe('The review was not posted. The forge did not answer.');
    expect(refusalWords(500)).toBe('The review was not posted. The server answered 500.');
  });
});

describe('the hold (D3)', () => {
  it('is 5 seconds, one constant', () => {
    expect(HOLD_MS).toBe(5000);
  });
  it('counts down in words, and says it once when it starts', () => {
    expect(holdWords('approved', 5)).toBe('Approving in 5 s');
    expect(holdWords('notes', 4.2)).toBe('Sending back in 5 s');
    expect(holdWords('approved', 0)).toBe('Approving in 0 s');
    expect(holdStartWords('approved', 5)).toBe('Approving in 5 seconds. Undo to stop it; nothing has been sent.');
  });
  it('says why it stopped, and always that nothing was sent', () => {
    for (const why of ['undo', 'escape', 'closed', 'other', 'hidden', 'offline', 'edits']) expect(holdCancelledWords('approved', why)).toMatch(/Nothing was sent\.$/);
    expect(holdCancelledWords('approved', 'closed')).toBe('The approval was stopped: the proposal was closed. Nothing was sent.');
    expect(holdCancelledWords('notes', 'offline')).toBe('The send back was stopped: you are offline. Nothing was sent.');
  });
});
