// @vitest-environment happy-dom
/**
 * The Work piece (pieces/work.js) on an instance of its own, as a host would mount it: what it must not do once it has ended, the order it is
 * mounted in beside the proposal piece, the one-dialog rule, and the focus trap in a root that is not the document (spec 0011 D2, D3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { createInstance } from '../../explorer/instance.js';
// @ts-expect-error plain JS modules, no declarations
import * as workPiece from '../../explorer/pieces/work.js';
// @ts-expect-error plain JS modules, no declarations
import * as proposalPiece from '../../explorer/pieces/proposal.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const json = (status, data) => ({ ok: status < 400, status, headers: new Headers(), json: async () => data });
const CONFIG = { forge: { type: 'github', url: 'https://git.example.test', repo: 'owner/name' }, signIn: { login: 'maintainer-one' }, agents: { runs: true } };
const PULL = { number: 7, title: 'Seven', state: 'open', draft: false, author: { login: 'a' }, labels: [], head: { ref: 'b', sha: 'sha7' }, base: { ref: 'main' }, url: 'https://git.example.test/pull/7', createdAt: ago(5), updatedAt: ago(4), mergedAt: null };
const ISSUE = { number: 5, title: 'Five', state: 'open', author: { login: 'a' }, labels: [], url: 'https://git.example.test/issues/5', createdAt: ago(5), updatedAt: ago(4), comments: 0 };
const RUN = { kind: 'code', profile: null, refs: { issue: 3 }, open: true, requestedBy: 'm', requestedAt: ago(5), via: 'dashboard', limits: null, stopRequested: null, checks: null, pull: null, nodes: ['a'], timeline: [], report: null, answer: null, runId: 'run-01JC8Z3Q5M7VXK2RT9N4B6HD03', status: 'working' };
const PLAN = { issue: { number: 5, title: 'Five', url: ISSUE.url }, slug: '0005-five', branch: 'spec/0005-five', file: 'docs/proposals/0005-five.json', base: 'main', title: 'Spec: Five', stub: '{}', body: 'b', digest: 'd1', existing: null };

/** A server: `answers[path]` overrides (a function of the init, or a status), `hold[path]` keeps an answer back until released; every request is kept */
function server({ answers = {}, hold = [] } = {}) {
  const calls = [];
  const held = [];
  const fetch = vi.fn((url, init = {}) => {
    const u = new URL(url, 'http://localhost');
    calls.push(`${init.method || 'GET'} ${u.pathname}`);
    const own = answers[u.pathname];
    const answer = typeof own === 'number' ? json(own, { ok: false, error: `No (${own}).` }) : own ? own(init) : (() => {
      if (u.pathname === '/api/agent-runs') return json(200, { ok: true, runs: [RUN], open: 1, maxOpen: 10, profiles: ['fast'], limits: {} });
      if (u.pathname === '/proposals') return json(200, []);
      if (u.pathname === '/api/forge/pulls') return json(200, { ok: true, at: ago(0.01), rate: '', items: [PULL] });
      if (u.pathname === '/api/forge/issues') return json(200, { ok: true, at: ago(0.01), rate: '', items: [ISSUE] });
      if (u.pathname === '/api/forge/issues/5/spec') return json(200, { ok: true, plan: PLAN });
      if (u.pathname === '/api/forge/pulls/7') return json(200, { ok: true, at: ago(0.01), rate: '', pull: PULL, files: [], checks: [{ id: 'run:1', name: 'test', state: 'success', url: null, rerunnable: false }] });
      return json(200, { ok: true, at: ago(0.01), rate: '', items: [] });
    })();
    if (hold.includes(u.pathname)) return new Promise((resolve) => held.push(() => resolve(answer)));
    return Promise.resolve(answer);
  });
  return { calls, fetch, release: () => { while (held.length) held.shift()(); } };
}
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A panel in a bare element root of the page, as a host app mounts it */
function make(srv, { config = CONFIG } = {}) {
  const outside = document.createElement('button');
  outside.textContent = 'The host page';
  document.body.append(outside);
  const root = document.createElement('div');
  document.body.append(root);
  const inst = createInstance({ root, fetch: srv.fetch });
  const work = workPiece.mount(root, inst, { config, clock: () => NOW });
  return { root, inst, work, outside, q: (sel) => root.querySelector(sel) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { document.body.innerHTML = ''; vi.useRealTimers(); });

describe('the Work piece, once it has ended', () => {
  it('asks nothing when the browser comes back online (the online listener ends with the piece, not with the instance)', async () => {
    const srv = server({ answers: { '/api/forge/pulls': 500 } });
    const one = make(srv);
    one.work.openForge({ tab: 'pulls' });
    await settle();
    expect(one.q('#forge-notice').hidden).toBe(false); // the list could not be read: an error that "back online" reads again
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(srv.calls.filter((c) => c === 'GET /api/forge/pulls')).toHaveLength(2); // (it does while the piece is there)
    one.work.destroy();
    const asked = srv.calls.length;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(srv.calls.length).toBe(asked);
    one.inst.destroy();
  });

  it('sends nothing that a part asks for after destroy()', async () => {
    const srv = server();
    const one = make(srv);
    await settle();
    one.work.openForge({ tab: 'pulls' });
    await settle();
    const refresh = one.work.refreshForge; // a caller that kept the function (a deep link, a test) and calls it late
    one.work.destroy();
    const asked = srv.calls.length;
    refresh({ quiet: true });
    await settle();
    expect(srv.calls.length).toBe(asked);
    one.inst.destroy();
  });

  it('stops following the map\'s paints, so a second panel on the same instance draws its marks once', async () => {
    const srv = server();
    const root = document.createElement('div');
    document.body.append(root);
    const inst = createInstance({ root, fetch: srv.fetch });
    const hooks = new Set();
    inst.map = { onPaint: (f) => { hooks.add(f); return () => hooks.delete(f); }, render() {}, isNodeVisible: () => true };
    inst.state.nodes = [{ id: 'a', type: 'app', label: 'a', x: 10, y: 10, r: 20 }];
    inst.state.activeLayers = { runs: true };
    const paint = () => hooks.forEach((f) => f({ version: Math.random(), nodes: [{ id: 'a', x: 10, y: 10, r: 20, alpha: 1 }] }, { x: 0, y: 0, zoom: 1 }));
    const first = workPiece.mount(root, inst, { config: CONFIG, clock: () => NOW });
    await settle();
    expect(hooks.size).toBe(1);
    first.destroy();
    expect(hooks.size).toBe(0);
    const second = workPiece.mount(root, inst, { config: CONFIG, clock: () => NOW });
    await settle();
    paint();
    expect(root.querySelectorAll('[data-corn="run-mark"]')).toHaveLength(1);
    second.destroy();
    inst.destroy();
  });
});

describe('the Work piece and the proposal piece, in either order', () => {
  const entryHidden = (root) => root.querySelector('#proposal-wrap').hidden;

  it('hides the Proposals entry when the panel started first, and shows it again when the panel ends', async () => {
    const srv = server();
    const one = make(srv);
    await settle();
    expect(one.work.isOn()).toBe(true);
    const bar = proposalPiece.mount(one.root, one.inst); // mounted after `work:available` was said
    expect(entryHidden(one.root)).toBe(true);
    one.work.destroy();
    expect(entryHidden(one.root)).toBe(false);
    bar.destroy();
    one.inst.destroy();
  });

  it('hides it when the proposal piece came first', async () => {
    const srv = server();
    const root = document.createElement('div');
    document.body.append(root);
    const inst = createInstance({ root, fetch: srv.fetch });
    const bar = proposalPiece.mount(root, inst);
    expect(entryHidden(root)).toBe(false);
    const work = workPiece.mount(root, inst, { config: CONFIG, clock: () => NOW });
    expect(entryHidden(root)).toBe(true);
    work.destroy();
    bar.destroy();
    inst.destroy();
  });

  it('answers work:open-specs (a bad proposal link\'s way on) by opening on Specs', async () => {
    const srv = server();
    const one = make(srv);
    await settle();
    expect(one.inst.ask('work:open-specs')).toBe(true);
    expect(one.work.isForgeOpen()).toBe(true);
    expect(one.q('[data-forge-kind="specs"]').getAttribute('aria-pressed')).toBe('true');
    one.work.destroy();
    expect(one.inst.ask('work:open-specs')).toBeUndefined();
    one.inst.destroy();
  });
});

describe('one dialog at a time', () => {
  it('Start an agent opened while a spec\'s plan is being read: the plan, when it comes, opens no second dialog over it', async () => {
    const srv = server({ hold: ['/api/forge/issues/5/spec'] });
    const one = make(srv);
    await settle();
    one.work.openForge({ tab: 'issues' });
    await settle();
    click(one.q('[data-forge-spec="5"]')); // the plan is asked for, and held
    await settle();
    click(one.q('[data-forge-agent="issue:5"]'));
    await settle();
    expect(one.q('#agent-start').hidden).toBe(false);
    srv.release();
    await settle();
    expect(one.q('#forge-confirm').hidden).toBe(true);
    expect(one.root.contains(document.activeElement) && one.q('#agent-start').contains(document.activeElement)).toBe(true);
    one.work.destroy();
    one.inst.destroy();
  });

  it('the confirm step open: Start an agent asked for from outside (the node panel, a link) does not open', async () => {
    const srv = server();
    const one = make(srv);
    await settle();
    one.work.openForge({ tab: 'pulls' });
    await settle();
    click(one.q('[data-forge-pr="7"]'));
    await settle();
    click(one.q('[data-forge-merge]'));
    expect(one.q('#forge-confirm').hidden).toBe(false);
    one.inst.emit('forge:start', { slug: '0042-x', returnTo: '#drawer-run-btn' });
    await settle();
    expect(one.q('#agent-start').hidden).toBe(true);
    one.work.destroy();
    one.inst.destroy();
  });
});

describe('the focus trap in a root that is not the document', () => {
  for (const dialog of ['confirm', 'agent']) {
    it(`brings the focus back when a script moves it to the host page behind the ${dialog} dialog`, async () => {
      const srv = server();
      const one = make(srv);
      await settle();
      one.work.openForge({ tab: 'pulls' });
      await settle();
      click(one.q('[data-forge-pr="7"]'));
      await settle();
      if (dialog === 'confirm') click(one.q('[data-forge-merge]')); else await one.work.openProposalStart('0042-x');
      const box = one.q(dialog === 'confirm' ? '#forge-confirm' : '#agent-start');
      expect(box.hidden).toBe(false);
      expect(box.contains(document.activeElement)).toBe(true);
      one.outside.focus();
      expect(box.contains(document.activeElement)).toBe(true);
      // closed, the trap is gone: the page has its focus back
      one.work.destroy();
      one.outside.focus();
      expect(document.activeElement).toBe(one.outside);
      one.inst.destroy();
    });
  }
});

describe('the tab strip\'s fade (F42)', () => {
  it('follows the strip\'s own size: a phone sheet expanding, or a host\'s box resized, with no window resize', async () => {
    const seen = [];
    vi.stubGlobal('ResizeObserver', class { constructor(cb) { this.cb = cb; seen.push(this); } observe() {} disconnect() { this.cb = null; } });
    try {
      const srv = server();
      const one = make(srv);
      await settle();
      const tabs = one.q('.hx-forge-tabs');
      const top = one.q('.hx-forge-top');
      expect(top.dataset.more).toBeUndefined(); // drawn while nothing was laid out
      Object.defineProperty(tabs, 'scrollWidth', { configurable: true, value: 500 });
      Object.defineProperty(tabs, 'clientWidth', { configurable: true, value: 360 });
      Object.defineProperty(top, 'offsetHeight', { configurable: true, value: 125 });
      for (const o of seen) if (o.cb) o.cb([]);
      expect(top.dataset.more).toBe('end');
      expect(top.parentElement.style.scrollPaddingTop).toBe('125px');
      one.work.destroy();
      expect(seen.every((o) => o.cb === null)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
