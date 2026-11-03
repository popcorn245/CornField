/**
 * @vitest-environment node
 *
 * Event hooks (server/hooks.js, PIPE-07) on their own: the settings (a secret is needed), what a delivery looks like
 * (the headers, the signature over the raw body, the payload's fixed fields), retries with backoff on a fake clock, the
 * audit rows, and that a dead, slow, redirecting or throwing receiver never reaches the caller. Against real receivers
 * on loopback at the end. The events a running server emits are test/server/hooks-events.test.js.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
// @ts-expect-error plain JS module, no declarations
import { createHooks, hooksSettings, sign, BACKOFF_MS, TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_PENDING } from '../../server/hooks.js';

const SECRET = 's3cret-'.repeat(6);
const NOW = Date.parse('2026-11-03T09:30:00.000Z');

/** A clock the test winds by hand: timers wait until `tick` reaches them */
function fakeTimer() {
  let now = 0;
  let next = 1;
  const queue = new Map();
  return {
    setTimeout: (fn, ms) => { const id = next++; queue.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { queue.delete(id); },
    get waiting() { return [...queue.values()].map((t) => t.at - now).sort((a, b) => a - b); },
    /** Moves the clock on by `ms`, running what falls due, and lets the promises settle */
    async tick(ms) {
      const to = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = to;
    },
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
/**
 * Waits until `cond()` holds: for what happens over a real socket (a loopback receiver), whose timing is the machine's.
 * It returns as soon as the condition holds; the deadline only turns a hang into a failure that says what it waited for.
 */
async function until(cond, what, deadlineMs = 15_000) {
  const end = Date.now() + deadlineMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A fetch that answers from a script and remembers what it was sent */
function fakeFetch(script = () => ({ status: 200 })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body, headers: init.headers });
    const out = await script(calls.length, url, init);
    if (out instanceof Error) throw out;
    return new Response(out.body ?? null, { status: out.status ?? 200, headers: out.headers });
  };
  fn.calls = calls;
  return fn;
}

function setup({ hooks = [{ url: 'https://chat.example.org/secret-path?token=abc', events: '*' }], script, publicUrl = 'https://cornfield.example.org', backoff } = {}) {
  const rows = [];
  const timer = fakeTimer();
  const fetch = fakeFetch(script);
  const h = createHooks({ hooks, secret: SECRET, fetch, record: async (e) => { rows.push(e); }, now: () => NOW, publicUrl, timer, ...(backoff ? { backoff } : {}) });
  return { h, rows, timer, fetch };
}

describe('hooksSettings', () => {
  it('is null with no hooks, whatever env says', () => {
    expect(hooksSettings({ hooks: [] }, {})).toBeNull();
    expect(hooksSettings({}, { CORNFIELD_HOOK_SECRET: SECRET })).toBeNull();
  });
  it('wants CORNFIELD_HOOK_SECRET of at least 32 characters when hooks are listed, and sign-in', () => {
    const config = { hooks: [{ url: 'https://a.example.org', events: '*' }] };
    expect(() => hooksSettings(config, {})).toThrow(/CORNFIELD_HOOK_SECRET is needed/);
    expect(() => hooksSettings(config, { CORNFIELD_HOOK_SECRET: '' })).toThrow(/is needed/);
    expect(() => hooksSettings(config, { CORNFIELD_HOOK_SECRET: 'x'.repeat(31) })).toThrow(/too short/);
    expect(() => hooksSettings(config, { CORNFIELD_HOOK_SECRET: SECRET }, false)).toThrow(/sign-in is not set up. Every event comes from something a signed-in maintainer does in cornfield .* so without sign-in no hook would ever fire/);
    expect(hooksSettings(config, { CORNFIELD_HOOK_SECRET: 'x'.repeat(32) }, true)).toEqual({ secret: 'x'.repeat(32) });
  });
  it('never puts the secret in an error', () => {
    const config = { hooks: [{ url: 'https://a.example.org', events: '*' }] };
    try { hooksSettings(config, { CORNFIELD_HOOK_SECRET: 'short-secret-value' }); } catch (err) { expect(err.message).not.toContain('short-secret-value'); }
  });
});

describe('a delivery', () => {
  it('is a POST of JSON with the event, delivery and timestamp headers and an HMAC-SHA256 of the raw body', async () => {
    const { h, fetch } = setup();
    h.emit('spec.approved', { slug: '0014-planner', pull: 42, headSha: 'a'.repeat(40), proposalSha256: 'b'.repeat(64), actor: 'maintainer-one', note: 'Looks right.', edits: [{ op: 'add-node' }] });
    await settle();
    expect(fetch.calls).toHaveLength(1);
    const [{ url, init }] = fetch.calls;
    expect(url).toBe('https://chat.example.org/secret-path?token=abc');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      event: 'spec.approved', at: '2026-11-03T09:30:00.000Z', slug: '0014-planner', pull: 42, headSha: 'a'.repeat(40), proposalSha256: 'b'.repeat(64),
      actor: 'maintainer-one', note: 'Looks right.', edits: [{ op: 'add-node' }], mapUrl: 'https://cornfield.example.org',
    });
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Cornfield-Event']).toBe('spec.approved');
    expect(init.headers['X-Cornfield-Delivery']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(init.headers['X-Cornfield-Timestamp']).toBe(body.at);
    // verified the way a receiver does: over the exact bytes sent, with the secret
    expect(init.headers['X-Cornfield-Signature']).toBe(`sha256=${createHmac('sha256', SECRET).update(init.body).digest('hex')}`);
    expect(sign(SECRET, init.body)).toBe(init.headers['X-Cornfield-Signature']);
    expect(sign('another-secret-of-thirty-two-chars!!', init.body)).not.toBe(init.headers['X-Cornfield-Signature']);
    expect(JSON.stringify([init.headers, init.body])).not.toContain(SECRET);
  });

  it('carries only the fixed fields: anything else in a payload (a file, a token, an email) is left out', async () => {
    const { h, fetch } = setup();
    h.emit('pr.landed', { slug: null, pull: 7, headSha: 'c'.repeat(40), actor: 'm', token: 'ghp_x', email: 'a@b.example', text: '{"file":"contents"}', note: undefined });
    await settle();
    expect(JSON.parse(fetch.calls[0].init.body)).toEqual({ event: 'pr.landed', at: '2026-11-03T09:30:00.000Z', slug: null, pull: 7, headSha: 'c'.repeat(40), proposalSha256: null, actor: 'm', mapUrl: 'https://cornfield.example.org' });
  });

  it('has a null map URL when there is no public URL, and no note or edits on an event that has none', async () => {
    const { h, fetch } = setup({ publicUrl: null });
    h.emit('build.opened', { slug: 's', pull: 1, headSha: 'd'.repeat(40), proposalSha256: 'e'.repeat(64), actor: 'm' });
    await settle();
    const body = JSON.parse(fetch.calls[0].init.body);
    expect(body.mapUrl).toBeNull();
    expect('note' in body).toBe(false);
    expect('edits' in body).toBe(false);
  });

  it('goes only to the hooks that asked for the event, each with its own delivery id and the same body', async () => {
    const { h, fetch } = setup({ hooks: [
      { url: 'https://a.example.org/h', events: ['spec.ready'] },
      { url: 'https://b.example.org/h', events: ['pr.landed', 'spec.ready'] },
      { url: 'https://c.example.org/h', events: '*' },
    ] });
    h.emit('spec.ready', { slug: 's', pull: 1 });
    await settle();
    expect(fetch.calls.map((c) => c.url).sort()).toEqual(['https://a.example.org/h', 'https://b.example.org/h', 'https://c.example.org/h']);
    expect(new Set(fetch.calls.map((c) => c.headers['X-Cornfield-Delivery'])).size).toBe(3);
    expect(new Set(fetch.calls.map((c) => c.body)).size).toBe(1);
    fetch.calls.length = 0;
    h.emit('pr.landed', { pull: 2 });
    await settle();
    expect(fetch.calls.map((c) => c.url).sort()).toEqual(['https://b.example.org/h', 'https://c.example.org/h']);
    fetch.calls.length = 0;
    h.emit('build.opened', { pull: 2 });
    await settle();
    expect(fetch.calls.map((c) => c.url)).toEqual(['https://c.example.org/h']);
  });

  it('ignores an event it does not know', async () => {
    const { h, fetch, rows } = setup();
    h.emit('spec.merged', {});
    await settle();
    expect(fetch.calls).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('takes a payload as a function (run in the background), and writes down one that fails, sending nothing', async () => {
    const { h, fetch, rows } = setup();
    h.emit('spec.ready', async () => ({ slug: 'late', pull: 3 }));
    await settle();
    expect(JSON.parse(fetch.calls[0].init.body).slug).toBe('late');
    fetch.calls.length = 0;
    const log = console.error;
    console.error = () => {};
    try {
      h.emit('spec.ready', () => { throw new Error('forge down'); });
      await settle();
    } finally { console.error = log; }
    expect(fetch.calls).toHaveLength(0);
    expect(rows.at(-1)).toMatchObject({ action: 'hook', status: null, answer: { ok: false, reason: 'payload' } });
  });

  it('returns before anything is sent, and the payload function is not run in the caller\'s turn', () => {
    const { h, fetch } = setup();
    let ran = false;
    expect(h.emit('pr.landed', () => { ran = true; return {}; })).toBeUndefined();
    expect(ran).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('the audit table', () => {
  it('gets a row per attempt: the event, the delivery, the hook\'s origin and the status, and never its path, its query, the secret or the body', async () => {
    const { h, rows, fetch } = setup();
    h.emit('spec.sentBack', { slug: 's', pull: 5, actor: 'm', note: 'private words' });
    await settle();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ login: 'cornfield', action: 'hook', target: 'spec.sentBack to https://chat.example.org', status: 200, answer: { ok: true } });
    expect(rows[0].request).toEqual({ event: 'spec.sentBack', delivery: fetch.calls[0].headers['X-Cornfield-Delivery'], hook: 0, origin: 'https://chat.example.org', attempt: 1 });
    const text = JSON.stringify(rows);
    for (const secret of [SECRET, 'secret-path', 'token=abc', 'private words']) expect(text).not.toContain(secret);
  });

  it('survives an audit table that cannot be written: the delivery is made all the same', async () => {
    const fetch = fakeFetch();
    const h = createHooks({ hooks: [{ url: 'https://a.example.org', events: '*' }], secret: SECRET, fetch, record: async () => { throw new Error('disk full'); }, timer: fakeTimer() });
    const log = console.error;
    console.error = () => {};
    try {
      h.emit('pr.landed', { pull: 1 });
      await settle();
    } finally { console.error = log; }
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('retries', () => {
  it('waits 1s, 5s and 30s after a failure, with the same delivery id and body each time, then gives up', async () => {
    expect(BACKOFF_MS).toEqual([1000, 5000, 30000]);
    const { h, fetch, rows, timer } = setup({ script: () => ({ status: 503 }) });
    h.emit('spec.ready', { slug: 's', pull: 1 });
    await settle();
    expect(fetch.calls).toHaveLength(1);
    expect(timer.waiting).toContain(1000);
    await timer.tick(999);
    expect(fetch.calls).toHaveLength(1);
    await timer.tick(1);
    expect(fetch.calls).toHaveLength(2);
    await timer.tick(4999);
    expect(fetch.calls).toHaveLength(2);
    await timer.tick(1);
    expect(fetch.calls).toHaveLength(3);
    await timer.tick(29_999);
    expect(fetch.calls).toHaveLength(3);
    await timer.tick(1);
    expect(fetch.calls).toHaveLength(4);
    await timer.tick(10 * 60_000);
    expect(fetch.calls).toHaveLength(4); // and no more
    expect(new Set(fetch.calls.map((c) => c.headers['X-Cornfield-Delivery'])).size).toBe(1);
    expect(new Set(fetch.calls.map((c) => c.body)).size).toBe(1);
    expect(rows.map((r) => [r.request.attempt, r.status, r.answer.ok, r.answer.retryInMs, r.answer.gaveUp])).toEqual([
      [1, 503, false, 1000, undefined], [2, 503, false, 5000, undefined], [3, 503, false, 30000, undefined], [4, 503, false, undefined, true],
    ]);
  });

  it('stops at the first success', async () => {
    const { h, fetch, rows, timer } = setup({ script: (n) => ({ status: n < 3 ? 500 : 204 }) });
    h.emit('pr.landed', { pull: 9 });
    await settle();
    await timer.tick(1000);
    await timer.tick(5000);
    expect(fetch.calls).toHaveLength(3);
    await timer.tick(60_000);
    expect(fetch.calls).toHaveLength(3);
    expect(rows.map((r) => r.answer.ok)).toEqual([false, false, true]);
    expect(timer.waiting).toEqual([]);
  });

  it('retries a network error and says what kind, without the error\'s message', async () => {
    const boom = Object.assign(new TypeError('fetch failed: https://chat.example.org/secret-path?token=abc'), { cause: { code: 'ECONNREFUSED' } });
    const { h, rows, timer, fetch } = setup({ script: (n) => (n === 1 ? boom : { status: 200 }) });
    h.emit('pr.landed', { pull: 9 });
    await settle();
    expect(rows[0]).toMatchObject({ status: null, answer: { ok: false, reason: 'ECONNREFUSED' } });
    await timer.tick(1000);
    expect(fetch.calls).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: 200, answer: { ok: true } });
    expect(JSON.stringify(rows)).not.toContain('secret-path');
  });

  it('counts a redirect as a failure and does not follow it', async () => {
    const { h, rows, fetch } = setup({ script: () => ({ status: 302, headers: { Location: 'https://elsewhere.example.org/' } }) });
    h.emit('pr.landed', { pull: 9 });
    await settle();
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].init.redirect).toBe('manual');
    expect(rows[0]).toMatchObject({ status: 302, answer: { ok: false, reason: 'redirect' } });
  });

  it('gives a request 10 seconds: a receiver that never answers is cut off and tried again', async () => {
    expect(TIMEOUT_MS).toBe(10_000);
    const { h, rows, timer, fetch } = setup({ script: (n, url, init) => (n === 1 ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) : { status: 200 }) });
    h.emit('pr.landed', { pull: 9 });
    await settle();
    expect(fetch.calls).toHaveLength(1);
    expect(rows).toHaveLength(0);
    await timer.tick(TIMEOUT_MS);
    expect(rows[0]).toMatchObject({ status: null, answer: { ok: false, reason: 'timeout' } });
    await timer.tick(1000);
    expect(fetch.calls).toHaveLength(2);
  });

  it('reads at most a few KB of an answer and drops the rest', async () => {
    let pulled = 0;
    const big = new ReadableStream({ pull(c) { pulled += 1024; c.enqueue(new Uint8Array(1024)); } });
    const fetch = async () => new Response(big, { status: 200 });
    const h = createHooks({ hooks: [{ url: 'https://a.example.org', events: '*' }], secret: SECRET, fetch, record: async () => {}, timer: fakeTimer() });
    h.emit('pr.landed', { pull: 1 });
    await settle();
    expect(pulled).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 4096);
    expect(pulled).toBeGreaterThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it('keeps each hook apart: one that is down does not hold up the others', async () => {
    const { h, fetch } = setup({
      hooks: [{ url: 'https://down.example.org/h', events: '*' }, { url: 'https://up.example.org/h', events: '*' }],
      script: (n, url) => ({ status: url.startsWith('https://down') ? 500 : 200 }),
    });
    h.emit('pr.landed', { pull: 1 });
    await settle();
    expect(fetch.calls.map((c) => c.url).sort()).toEqual(['https://down.example.org/h', 'https://up.example.org/h']);
  });

  it('drops a delivery past the queue\'s limit and writes that down', async () => {
    const { h, rows, fetch } = setup({ script: () => ({ status: 500 }) });
    for (let i = 0; i < MAX_PENDING + 3; i++) h.emit('pr.landed', { pull: i });
    await settle();
    expect(fetch.calls).toHaveLength(MAX_PENDING);
    expect(rows.filter((r) => r.answer.reason === 'queue-full')).toHaveLength(3);
  });

  it('close() cancels the retries still waiting', async () => {
    const { h, fetch, timer } = setup({ script: () => ({ status: 500 }) });
    h.emit('pr.landed', { pull: 1 });
    await settle();
    h.close();
    expect(timer.waiting).toEqual([]);
    await timer.tick(60_000);
    expect(fetch.calls).toHaveLength(1);
    h.emit('pr.landed', { pull: 2 });
    await settle();
    expect(fetch.calls).toHaveLength(1);
  });

  it('close() during a request in flight leaves nothing behind: no row, no retry, no timer', async () => {
    let answer;
    const rows = [];
    const timer = fakeTimer();
    const h = createHooks({ hooks: [{ url: 'https://a.example.org/h', events: '*' }], secret: SECRET, record: async (e) => { rows.push(e); }, timer, fetch: () => new Promise((ok) => { answer = ok; }) });
    h.emit('pr.landed', { pull: 3 });
    await until(() => answer !== undefined, 'the request to start');
    h.close();
    // No socket here: the answer resolves in the same process, so settling the promises is enough
    answer(new Response('down', { status: 500 }));
    await settle();
    await settle();
    expect(rows).toEqual([]);
    expect(timer.waiting).toEqual([]);
  });
});

describe('a hook that cannot hurt', () => {
  it('never throws to its caller: a fetch that throws at once, a record that throws, a payload that is not an object', async () => {
    const h = createHooks({
      hooks: [{ url: 'https://a.example.org', events: '*' }], secret: SECRET, record: () => { throw new Error('no table'); }, timer: fakeTimer(),
      fetch: () => { throw new Error('sync boom'); },
    });
    const log = console.error;
    console.error = () => {};
    try {
      for (const payload of [{ pull: 1 }, null, undefined, 5, 'text', () => null, () => { throw new Error('x'); }]) expect(() => h.emit('pr.landed', payload)).not.toThrow();
      expect(() => h.emit(undefined, {})).not.toThrow();
      expect(() => h.emit('pr.landed')).not.toThrow();
      await settle();
    } finally { console.error = log; }
  });

  it('does not start without a long secret', () => {
    expect(() => createHooks({ hooks: [], secret: 'short' })).toThrow(/at least 32/);
    expect(() => createHooks({ hooks: [], secret: undefined })).toThrow(/at least 32/);
  });
});

describe('against a receiver on loopback', () => {
  const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });

  it('delivers a signed body the receiver can verify, and follows no redirect', async () => {
    const got = [];
    const elsewhere = [];
    const other = await listen((req, res) => { elsewhere.push(req.url); res.end('x'); });
    const receiver = await listen((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        got.push({ headers: req.headers, raw: Buffer.concat(chunks) });
        if (got.length === 1) { res.writeHead(307, { Location: other.url }); res.end(); } else { res.writeHead(200); res.end('ok'); }
      });
    });
    const rows = [];
    const timer = fakeTimer();
    const h = createHooks({ hooks: [{ url: receiver.url, events: '*' }], secret: SECRET, record: async (e) => { rows.push(e); }, now: () => NOW, timer });
    // Not ASCII: the signature is over the exact bytes sent, so a receiver that hashes what it got agrees
    h.emit('spec.sentBack', { slug: '0014-planner', pull: 11, headSha: 'f'.repeat(40), actor: 'maintainer-one', note: 'Café, 中文, «quotes» and \u2028 a line separator' });
    await until(() => got.length === 1, 'the first request');
    // The first attempt's answer (the 307) comes back over a real socket: tick only once its retry is in the timer
    await until(() => rows.length === 1 && timer.waiting.includes(1000), 'the retry to be scheduled after the refused redirect');
    await timer.tick(1000);
    await until(() => got.length === 2, 'the retry');
    expect(got).toHaveLength(2);
    expect(elsewhere).toEqual([]);
    // The verify function docs/config.md gives a receiver, as it is written there
    const verify = (raw, header, secret, maxAgeMs = 300_000) => {
      const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`), have = Buffer.from(String(header));
      return want.length === have.length && timingSafeEqual(want, have) && Math.abs(NOW - Date.parse(JSON.parse(raw).at)) < maxAgeMs;
    };
    for (const g of got) {
      expect(g.headers['content-type']).toBe('application/json');
      expect(g.headers['x-cornfield-event']).toBe('spec.sentBack');
      expect(g.headers['x-cornfield-signature']).toBe(`sha256=${createHmac('sha256', SECRET).update(g.raw).digest('hex')}`);
      expect(verify(g.raw, g.headers['x-cornfield-signature'], SECRET)).toBe(true);
      expect(verify(g.raw, g.headers['x-cornfield-signature'], `${SECRET}x`)).toBe(false);
      expect(verify(Buffer.concat([g.raw, Buffer.from(' ')]), g.headers['x-cornfield-signature'], SECRET)).toBe(false);
      expect(JSON.parse(g.raw.toString('utf8'))).toMatchObject({ pull: 11, note: 'Café, 中文, «quotes» and \u2028 a line separator' });
    }
    expect(got[0].headers['x-cornfield-delivery']).toBe(got[1].headers['x-cornfield-delivery']);
    await until(() => rows.length === 2, 'the second attempt\'s audit row');
    expect(rows.map((r) => r.status)).toEqual([307, 200]);
    expect(timer.waiting).toEqual([]);
    h.close();
    receiver.server.close();
    other.server.close();
  });

  it('writes down a dead URL and carries on', async () => {
    const dead = await listen(() => {});
    const url = dead.url;
    await new Promise((r) => dead.server.close(r)); // nothing listens there now
    const rows = [];
    const h = createHooks({ hooks: [{ url, events: '*' }], secret: SECRET, record: async (e) => { rows.push(e); }, timer: fakeTimer() });
    expect(() => h.emit('pr.landed', { pull: 1 })).not.toThrow();
    await until(() => rows.length === 1, 'the refused connection\'s audit row');
    expect(rows[0]).toMatchObject({ action: 'hook', status: null, answer: { ok: false, reason: 'ECONNREFUSED' } });
    h.close();
  });
});
