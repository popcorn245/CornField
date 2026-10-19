/**
 * @vitest-environment node
 *
 * The pure half of approving and sending back (TOPO-12): the words for the time and the verdict, the
 * body that goes to the server, and which spec a proposal belongs to.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { relativeTime, reviewWords, sendBackProblem, reviewBody, editsHint, specNumber, isReviewable, NOT_ON_A_PR } from '../../explorer/review-model.js';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const ago = (ms        ) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('relativeTime', () => {
  it('is plain words: just now, minutes, hours, days', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now');
    expect(relativeTime(ago(59_000), NOW)).toBe('just now');
    expect(relativeTime(ago(MIN), NOW)).toBe('1 minute ago');
    expect(relativeTime(ago(3 * MIN + 30_000), NOW)).toBe('3 minutes ago');
    expect(relativeTime(ago(59 * MIN), NOW)).toBe('59 minutes ago');
    expect(relativeTime(ago(60 * MIN), NOW)).toBe('1 hour ago');
    expect(relativeTime(ago(5 * 60 * MIN), NOW)).toBe('5 hours ago');
    expect(relativeTime(ago(24 * 60 * MIN), NOW)).toBe('1 day ago');
    expect(relativeTime(ago(10 * 24 * 60 * MIN), NOW)).toBe('10 days ago');
  });
  it('never says a negative: a time ahead of the clock is just now, and what does not read is empty', () => {
    expect(relativeTime(ago(-5 * MIN), NOW)).toBe('just now');
    for (const bad of ['', 'yesterday', null, undefined, 5, {}]) expect(relativeTime(bad       , NOW)).toBe('');
    expect(relativeTime(ago(0), NaN)).toBe('');
  });
});

describe('reviewWords', () => {
  it('says Approved or Sent back, and when', () => {
    expect(reviewWords({ verdict: 'approved', at: ago(3 * MIN) }, NOW)).toBe('Approved 3 minutes ago');
    expect(reviewWords({ verdict: 'notes', at: ago(0) }, NOW)).toBe('Sent back just now');
    expect(reviewWords({ verdict: 'notes', at: 'garbled' }, NOW)).toBe('Sent back');
  });
  it('is empty for no review or a verdict it does not know', () => {
    for (const none of [null, undefined, {}, { verdict: 'maybe', at: ago(0) }]) expect(reviewWords(none       , NOW)).toBe('');
  });
});

describe('sendBackProblem', () => {
  it('wants some words', () => {
    for (const empty of ['', '  ', '\n\t', null, undefined, 5]) expect(sendBackProblem(empty       )).toMatch(/what should change/i);
    expect(sendBackProblem('Drop the cache.')).toBeNull();
  });
});

describe('reviewBody', () => {
  it('is the verdict, the trimmed note and the edits, as copies', () => {
    const edits = [{ op: 'add-node', id: 'x' }];
    const body = reviewBody('notes', '  Drop the cache.  ', edits);
    expect(body).toEqual({ verdict: 'notes', note: 'Drop the cache.', edits });
    expect(body.edits).not.toBe(edits);
    expect(body.edits[0]).not.toBe(edits[0]);
    expect(Object.keys(body)).toEqual(['verdict', 'note', 'edits']);
  });
  it('has an empty note and no edits when given none', () => {
    expect(reviewBody('approved', undefined       , undefined       )).toEqual({ verdict: 'approved', note: '', edits: [] });
  });
});

describe('editsHint', () => {
  it('says nothing when there are no edits, and that the agent folds them in when there are', () => {
    expect(editsHint('approved', 0)).toBe('');
    expect(editsHint('notes', 0)).toBe('');
    expect(editsHint('approved', 1)).toBe('Your 1 edit is in the review comment on the PR. The drafting agent will fold it into the proposal.');
    expect(editsHint('approved', 3)).toBe('Your 3 edits are in the review comment on the PR. The drafting agent will fold them into the proposal.');
    expect(editsHint('notes', 2)).toBe('Sent with your 2 edits. The drafting agent will fold them into the next draft.');
  });
});

describe('specNumber', () => {
  it('reads the proposal\'s spec field as a whole number', () => {
    expect(specNumber('0013')).toBe(13);
    expect(specNumber('13')).toBe(13);
    expect(specNumber(' 0012 ')).toBe(12);
    expect(specNumber(13)).toBe(13);
  });
  it('is null for anything else', () => {
    for (const bad of [null, undefined, '', '0000', 0, -3, 1.5, 'spec 13', '0013-meals', '1e3', '12345678', {}, [], true]) expect(specNumber(bad       ), String(bad)).toBeNull();
  });
});

describe('isReviewable', () => {
  it('is true for a proposal of a spec PR and for nothing else', () => {
    for (const ok of ['pull/1', 'pull/23', 'pull/123456789']) expect(isReviewable(ok), ok).toBe(true);
    for (const no of ['checkout', 'topo-09', 'pull/', 'pull/0', 'pull/01', 'pull/1234567890', 'pull/2/files', 'Pull/2', '', null, undefined, 23]) expect(isReviewable(no), String(no)).toBe(false);
  });
  it('has words for a draft that is not on a PR', () => {
    expect(NOT_ON_A_PR).toMatch(/spec PR/);
  });
});
