import { describe, it, expect } from 'vitest';
import {
  MAX_MENTIONS, MAX_REF, parseMentions, resolveMention, resolveMentions, linksOf, threadOfPull, normalizeRef, nodesForFile, scan,
  // @ts-expect-error plain JS module, no declarations
} from '../../core/mentions.js';

const NODES = [
  { id: 'core-server-auth', type: 'core', file: 'server/auth.js' },
  { id: 'core-server-hooks', type: 'core', file: 'server/hooks.js' },
  { id: 'dir-server', type: 'stack', file: 'server' },
  { id: 'page-a', type: 'page', file: 'explorer/a.js' },
  { id: 'comp-a', type: 'atom', file: 'explorer/a.js' },
  { id: 'no-file', type: 'external' },
];

describe('parseMentions', () => {
  it('reads [[…]] in prose, each once, in order', () => {
    expect(parseMentions('See [[core-server-auth]] and [[server/hooks.js]], then [[core-server-auth]] again.').refs).toEqual(['core-server-auth', 'server/hooks.js']);
  });

  it('ignores fenced blocks, tilde fences, inline spans and an escaped open', () => {
    const text = [
      'Real: [[a-real]]',
      '```js',
      'const x = "[[in-fence]]";',
      '```',
      '~~~',
      '[[in-tilde]]',
      '~~~',
      'Inline `[[in-span]]` and ``[[in `double` span]]`` too, \\[[escaped]], and [[b-real]].',
    ].join('\n');
    expect(parseMentions(text).refs).toEqual(['a-real', 'b-real']);
  });

  it('a fence left open runs to the end of the text', () => {
    expect(parseMentions('[[x]]\n```\n[[y]]\nnever closed').refs).toEqual(['x']);
  });

  it('a longer closing fence closes, a shorter one does not', () => {
    const text = '````\n```\n[[inside]]\n```\n````\n[[outside]]';
    expect(parseMentions(text).refs).toEqual(['outside']);
  });

  it('strips ./, a trailing slash, #L10 and :10 from paths, and drops empty, absolute and .. references', () => {
    expect(parseMentions('[[./server/auth.js]] [[server/]] [[server/auth.js#L10]] [[server/auth.js:12-20]] [[  ]] [[/etc/passwd]] [[../x]]').refs).toEqual(['server/auth.js', 'server']);
    expect(normalizeRef('a'.repeat(MAX_REF + 1))).toBeNull();
  });

  it('caps the references of one text', () => {
    const many = Array.from({ length: MAX_MENTIONS + 20 }, (_, i) => `[[n${i}]]`).join(' ');
    const got = parseMentions(many);
    expect(got.refs).toHaveLength(MAX_MENTIONS);
    expect(got.truncated).toBe(true);
    expect(parseMentions('[[a]]').truncated).toBe(false);
  });

  it('reads a cornfield-thread block and ignores a malformed one', () => {
    const good = 'text\n```cornfield-thread\n{ "nodes": ["core-server-auth", "./server/hooks.js", 7], "proposal": "0013-meals" }\n```';
    expect(parseMentions(good)).toMatchObject({ refs: [], block: { nodes: ['core-server-auth', 'server/hooks.js'], proposal: '0013-meals' } });
    expect(parseMentions('```cornfield-thread\n{ nope\n```').block).toBeNull();
    expect(parseMentions('```cornfield-thread\n[1]\n```').block).toBeNull();
    expect(parseMentions('```cornfield-thread\n{ "nodes": [] }\n```').block).toBeNull();
    expect(parseMentions('```cornfield-thread\n{ "proposal": "../../x" }\n```').block).toBeNull();
    // a block quoted inside another fence is not one; one in an indented-text example with a different info is not either
    expect(parseMentions('````\n```cornfield-thread\n{"nodes":["a"]}\n```\n````').block).toBeNull();
    expect(parseMentions('```json\n{"nodes":["a"]}\n```').block).toBeNull();
  });

  it('the first well-formed block wins', () => {
    const text = '```cornfield-thread\n{bad\n```\n```cornfield-thread\n{"nodes":["a"]}\n```\n```cornfield-thread\n{"nodes":["b"]}\n```';
    expect(parseMentions(text).block.nodes).toEqual(['a']);
  });

  it('is safe on anything', () => {
    expect(parseMentions(undefined).refs).toEqual([]);
    expect(parseMentions(null).block).toBeNull();
    expect(scan('a\r\n```\r\nb\r\n```\r\n').prose).not.toContain('b');
  });
});

describe('resolveMention', () => {
  it('an id wins over a path', () => {
    expect(resolveMention('core-server-auth', NODES).map((n) => n.id)).toEqual(['core-server-auth']);
    const clash = [{ id: 'server/auth.js', file: 'x.js' }, ...NODES];
    expect(resolveMention('server/auth.js', clash).map((n) => n.id)).toEqual(['server/auth.js']);
  });

  it('an exact path beats the folder that owns it', () => {
    expect(resolveMention('server/auth.js', NODES).map((n) => n.id)).toEqual(['core-server-auth']);
    expect(resolveMention('./server/auth.js#L3', NODES).map((n) => n.id)).toEqual(['core-server-auth']);
  });

  it('a file that holds several nodes lights them all', () => {
    expect(resolveMention('explorer/a.js', NODES).map((n) => n.id)).toEqual(['page-a', 'comp-a']);
  });

  it('a path with no node of its own goes to the deepest node that owns it', () => {
    expect(resolveMention('server/forge.js', NODES).map((n) => n.id)).toEqual(['dir-server']);
    expect(resolveMention('server/deep/er/x.js', NODES).map((n) => n.id)).toEqual(['dir-server']);
  });

  it('something on no node resolves to nothing; a nearby name is not a prefix', () => {
    expect(resolveMention('docs/vision.md', NODES)).toEqual([]);
    expect(resolveMention('serverless/x.js', NODES)).toEqual([]);
    expect(resolveMention('', NODES)).toEqual([]);
    expect(resolveMention('no-file', NODES).map((n) => n.id)).toEqual(['no-file']);
  });

  it('nodesForFile is the rule a pull request lights by', () => {
    expect(nodesForFile('server/auth.js', NODES).map((n) => n.id)).toEqual(['core-server-auth']);
    expect(nodesForFile('README.md', NODES)).toEqual([]);
  });
});

describe('resolveMentions and linksOf', () => {
  it('collects the nodes once and keeps what did not resolve', () => {
    const got = resolveMentions(['server/auth.js', 'core-server-auth', 'nowhere.md', 'explorer/a.js'], NODES);
    expect(got.ids).toEqual(['core-server-auth', 'page-a', 'comp-a']);
    expect(got.unresolved).toEqual(['nowhere.md']);
    expect(got.resolved[0]).toEqual({ ref: 'server/auth.js', ids: ['core-server-auth'] });
    expect(resolveMentions(undefined, NODES).ids).toEqual([]);
  });

  it('puts the references of many messages and their blocks together, with the first proposal', () => {
    const got = linksOf([
      'one [[a]] [[b]]',
      'two [[b]] [[c]]\n```cornfield-thread\n{"nodes":["d","a"],"proposal":"0013-meals"}\n```',
      '```cornfield-thread\n{"nodes":["e"],"proposal":"0014-other"}\n```',
    ]);
    expect(got.refs).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(got.proposal).toBe('0013-meals');
    expect(got.truncated).toBe(false);
  });

  it('caps the references of a whole thread', () => {
    const texts = Array.from({ length: 10 }, (_, m) => Array.from({ length: 30 }, (_, i) => `[[m${m}n${i}]]`).join(' '));
    const got = linksOf(texts);
    expect(got.refs.length).toBeLessThanOrEqual(MAX_MENTIONS * 2);
    expect(got.truncated).toBe(true);
  });
});

describe('threadOfPull', () => {
  it('reads Thread: #n and Closes #n, outside code', () => {
    expect(threadOfPull('Spec for meals.\n\nThread: #41')).toBe(41);
    expect(threadOfPull('thread:  #7')).toBe(7);
    expect(threadOfPull('Closes #12')).toBe(12);
    expect(threadOfPull('This fixes #3.')).toBe(3);
    expect(threadOfPull('Resolved #5')).toBe(5);
  });

  it('is null for a code span, another repo, or nothing', () => {
    expect(threadOfPull('`Closes #12`')).toBeNull();
    expect(threadOfPull('```\nThread: #4\n```')).toBeNull();
    expect(threadOfPull('Closes other/repo#9')).toBeNull();
    expect(threadOfPull('see #12')).toBeNull();
    expect(threadOfPull('')).toBeNull();
    expect(threadOfPull(undefined)).toBeNull();
  });
});

describe('hostile text costs about what its length does', () => {
  // A pull request's text is up to 65,536 characters on the forges, and the poll reads every open spec PR's
  const within = (ms, fn) => { const t = performance.now(); fn(); return performance.now() - t < ms; };

  it('threadOfPull: a long run of spaces (or a code block, blanked to spaces) after "Closes" is read once, not quadratically', () => {
    expect(within(300, () => threadOfPull(`Closes${' '.repeat(65000)}x`))).toBe(true);
    expect(within(300, () => threadOfPull(`Fixes:${' '.repeat(65000)}x`))).toBe(true);
    expect(within(300, () => threadOfPull(`Resolves \`${'a'.repeat(64000)}\` x`))).toBe(true);
    expect(within(300, () => threadOfPull(`closes ${' '.repeat(30000)}`.repeat(2)))).toBe(true);
    // and still reads what it should
    expect(threadOfPull('Fixes   #9')).toBe(9);
    expect(threadOfPull('closes:\n#8')).toBe(8);
    expect(threadOfPull('thread #12')).toBeNull();
  });

  it('parseMentions: brackets by the thousand, an unclosed mention, backtick runs, open fences', () => {
    expect(within(500, () => parseMentions(`[[${'a'.repeat(399)}`.repeat(160)))).toBe(true);
    expect(within(500, () => parseMentions('[['.repeat(32000)))).toBe(true);
    expect(within(500, () => parseMentions('[[x]]'.repeat(13000)))).toBe(true);
    expect(within(1000, () => { let s = ''; for (let i = 1; s.length < 65000; i++) s += `${'`'.repeat(i)}a`; parseMentions(s); })).toBe(true);
    expect(within(500, () => parseMentions('```\n'.repeat(16000)))).toBe(true);
    expect(parseMentions('[[x]]'.repeat(13000)).refs).toEqual(['x']);
  });
});
