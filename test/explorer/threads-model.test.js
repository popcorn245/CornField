import { describe, it, expect } from 'vitest';
import {
  KINDS, STATES, listUrl, listKeyOf, threadsUrl, threadUrl, IDEAS_URL, threadKindWords, threadMeta, mentionsOf, litForThread, messageNodes, mentionsIndex,
  ideaRequest, ideaWords, filterItems, nodesForFile,
  // @ts-expect-error plain JS module, no declarations
} from '../../explorer/forge-panel-model.js';

const NODES = [
  { id: 'core-auth', type: 'core', file: 'server/auth.js', label: 'auth.js' },
  { id: 'core-hooks', type: 'core', file: 'server/hooks.js', label: 'hooks.js' },
  { id: 'pkg-server', type: 'pkg', file: 'server', label: 'server' },
  { id: 'ext', type: 'external', label: 'ext' },
];
const NOW = Date.parse('2026-10-19T12:00:00Z');
const thread = (extra = {}) => ({ kind: 'idea', number: 41, title: 'Rework sign-in', state: 'open', author: { login: 'maintainer-one' }, labels: ['idea'], comments: 2, updatedAt: '2026-10-19T11:00:00Z', refs: [], ...extra });

describe('what the Threads tab asks', () => {
  it('is a kind of the panel with its own states and addresses', () => {
    expect(KINDS).toContain('threads');
    expect(STATES.threads.map(([v]) => v)).toEqual(['open', 'closed', 'all']);
    expect(threadsUrl('all')).toBe('/api/forge/threads?state=all&limit=100');
    expect(listUrl('threads', 'open')).toBe('/api/forge/threads?state=open&limit=100');
    expect(listKeyOf('threads', 'open')).toBe('threads|open');
    expect(threadUrl(41)).toBe('/api/forge/threads/41');
    expect(IDEAS_URL).toBe('/api/forge/threads');
  });

  it('filters threads by state and by a search over the title, number and author', () => {
    const items = [thread(), thread({ number: 42, title: 'Other', state: 'closed', author: { login: 'agent-four' } })];
    expect(filterItems(items, 'threads', { state: 'open', label: '', author: '', text: '' }).map((t) => t.number)).toEqual([41]);
    expect(filterItems(items, 'threads', { state: 'all', label: '', author: '', text: 'agent' }).map((t) => t.number)).toEqual([42]);
    expect(filterItems(items, 'threads', { state: 'all', label: '', author: '', text: '#41' }).map((t) => t.number)).toEqual([41]);
  });
});

describe('the words', () => {
  it('names the kind and counts the comments', () => {
    expect(threadKindWords(thread())).toBe('Idea');
    expect(threadKindWords(thread({ kind: 'proposal', slugs: ['0040-meals'] }))).toBe('Proposal 0040-meals');
    expect(threadKindWords(thread({ kind: 'proposal' }))).toBe('Proposal');
    expect(threadMeta(thread(), NOW)).toBe('#41 · maintainer-one · 2 comments · 1 hour ago');
    expect(threadMeta(thread({ comments: 1, author: null }), NOW)).toContain('someone · 1 comment ·');
    expect(threadMeta(thread({ kind: 'proposal', comments: 0 }), NOW)).toContain('no comments');
  });

  it('says what a new idea came to', () => {
    expect(ideaWords('GitHub', { ok: true, body: { number: 77 } })).toBe('Opened idea #77 on GitHub. It shows in the list within a minute.');
    expect(ideaWords('GitHub', { ok: false, status: 401, body: null })).toBe('Your sign-in has ended. Sign in again to open an idea.');
    expect(ideaWords('GitHub', { ok: false, status: 429, body: { error: 'Wait a little.' } })).toBe('Wait a little.');
    expect(ideaWords('GitHub', { ok: false, status: null, body: null })).toMatch(/could not be reached/);
  });

  it('trims a new idea and wants a title', () => {
    expect(ideaRequest('  A title ', ' text\n')).toEqual({ title: 'A title', body: 'text' });
    expect(ideaRequest('A', undefined)).toEqual({ title: 'A', body: '' });
    expect(ideaRequest('   ', 'text')).toBeNull();
    expect(ideaRequest(null, null)).toBeNull();
  });
});

describe('what a thread lights', () => {
  it('uses the rule a pull request lights its files by', () => {
    expect(nodesForFile('server/auth.js', NODES).map((n) => n.id)).toEqual(['core-auth']);
  });

  it('lights the nodes the messages mention outside code, with the ones on no node left as text', () => {
    const t = { messages: [
      { id: 'opening', body: 'See [[server/auth.js]] and [[nowhere.md]]' },
      { id: '1', body: '`[[core-hooks]]` is code\n```\n[[core-hooks]]\n```\nbut [[server/x.js]] is the folder\'s' },
      { id: '2', body: '```cornfield-thread\n{"nodes":["core-hooks"]}\n```' },
    ] };
    const lit = litForThread(t, NODES);
    expect([...lit.changed].sort()).toEqual(['core-auth', 'core-hooks', 'pkg-server']);
    expect(lit.failing.size).toBe(0);
    expect(lit.unresolved).toEqual(['nowhere.md']);
    expect(lit.nodes.map((n) => n.id)).toEqual(['core-auth', 'pkg-server', 'core-hooks']);
    expect(lit.perMessage.get('opening')).toMatchObject({ unresolved: ['nowhere.md'] });
    expect(lit.perMessage.get('opening').nodes.map((n) => n.id)).toEqual(['core-auth']);
    expect(lit.perMessage.get('1').nodes.map((n) => n.id)).toEqual(['pkg-server']);
    expect(lit.perMessage.get('2').nodes.map((n) => n.id)).toEqual(['core-hooks']);
  });

  it('a thread that mentions nothing lights nothing', () => {
    const lit = litForThread({ messages: [{ id: 'opening', body: 'no links, just words' }] }, NODES);
    expect(lit.nodes).toEqual([]);
    expect(lit.changed.size).toBe(0);
  });

  it('mentionsOf and messageNodes resolve against the map given', () => {
    expect(mentionsOf(['core-auth', 'zzz'], NODES)).toMatchObject({ ids: ['core-auth'], unresolved: ['zzz'] });
    expect(messageNodes('[[ext]]', NODES).nodes.map((n) => n.id)).toEqual(['ext']);
    expect(messageNodes('[[ext]]', []).unresolved).toEqual(['ext']);
  });
});

describe('which threads mention which node', () => {
  it('indexes the list against the map on screen, in the order of the list', () => {
    const items = [thread({ number: 41, refs: ['server/auth.js', 'core-hooks'] }), thread({ number: 40, kind: 'proposal', refs: ['server/hooks.js', 'server/other.js'] }), thread({ number: 42, refs: [] }), thread({ number: 43, refs: undefined })];
    const index = mentionsIndex(items, NODES);
    expect(index.get('core-auth').map((t) => t.number)).toEqual([41]);
    expect(index.get('core-hooks').map((t) => t.number)).toEqual([41, 40]);
    expect(index.get('pkg-server').map((t) => t.number)).toEqual([40]);
    expect(index.get('ext')).toBeUndefined();
    // a map without the node: the mention goes to what owns the file now
    expect([...mentionsIndex(items, NODES.filter((n) => n.id !== 'core-auth')).keys()].sort()).toEqual(['core-hooks', 'pkg-server']);
  });
});

describe('litForThread on a thread that is not there', () => {
  it('lights nothing and never throws: not loaded, an answer without one, odd messages', () => {
    for (const t of [undefined, null, {}, { messages: null }, { messages: [null, { id: 'x' }, { id: 'y', body: 7 }] }]) {
      const lit = litForThread(t, NODES);
      expect([lit.nodes, lit.unresolved, lit.changed.size, lit.perMessage.size]).toEqual([[], [], 0, 0]);
    }
  });
});
