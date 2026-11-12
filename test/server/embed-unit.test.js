/**
 * @vitest-environment node
 *
 * server/embed.js on its own: the list of routes is exactly the one the spec names (adding a route is a deliberate change of this test),
 * `listedWrite` and `listedReturn` decide on headers and URLs alone.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module, no declarations
import { ROUTES, WRITES, routeOf, listedWrite, listedReturn, absoluteUrl, createEmbed } from '../../server/embed.js';

const ORIGINS = ['https://tasks.example.com', 'http://localhost:5173'];

describe('the routes a listed origin may reach', () => {
  const shape = (p) => { const r = routeOf(p); return r ? `${r.kind} ${r.methods.join(',')}${r.headers.length ? ` [${r.headers}]` : ''}` : null; };
  it('are exactly these, and nothing else', () => {
    expect(ROUTES.map((r) => `${r.test} ${r.kind} ${r.methods.join(',')} [${r.headers}]`)).toEqual([
      '/cornfield/config.json session GET,HEAD []', '/topology.json session GET,HEAD []', '/topology.cloud.json session GET,HEAD []', '/proposals session GET,HEAD []',
      '/^\\/proposals\\/[^/]+\\.json$/ session GET,HEAD []', '/^\\/proposals\\/[^/]+\\/decision$/ session GET,HEAD []', '/^\\/proposals\\/[^/]+\\/review$/ session GET,HEAD,PUT [content-type]',
      '/^\\/proposals\\/[^/]+\\/mockups$/ session GET,HEAD []', '/^\\/api\\/forge\\/pulls\\/[1-9]\\d{0,8}$/ session GET,HEAD []',
      '/^\\/api\\/forge\\/pulls\\/[1-9]\\d{0,8}\\/landing\\/cancel$/ session POST [content-type]',
      '/cornfield/theme.css open GET,HEAD []', '/^\\/cornfield\\/theme\\/[^/]+\\.css$/ open GET,HEAD []', '/^\\/cornfield\\/theme\\/assets\\/.+$/ open GET,HEAD []',
    ]);
    expect(WRITES).toEqual(['PUT /proposals/<slug>/review', 'POST /api/forge/pulls/<n>/landing/cancel']);
  });
  it('match the paths the map and the review use, not the neighbours', () => {
    expect(shape('/proposals/0040-meals/review')).toBe('session GET,HEAD,PUT [content-type]');
    expect(shape('/proposals/0040-meals/mockups')).toBe('session GET,HEAD');
    expect(shape('/api/forge/pulls/40')).toBe('session GET,HEAD');
    expect(shape('/api/forge/pulls/40/landing/cancel')).toBe('session POST [content-type]');
    expect(shape('/cornfield/theme/night.css')).toBe('open GET,HEAD');
    expect(shape('/cornfield/theme/assets/fonts/a.woff2')).toBe('open GET,HEAD');
    for (const p of ['/api/review-tokens', '/api/review-tokens/1', '/api/agent-tokens', '/api/agent-runs', '/api/agent-runs/x', '/api/agent-requests', '/api/runs/x', '/api/reviews', '/api/forge/pulls', '/api/forge/pulls/40/merge',
      '/api/forge/pulls/40/rerun', '/api/forge/pulls/40/landing', '/api/forge/pulls/40/build', '/api/forge/issues', '/api/forge/threads', '/api/forge/pulls/0', '/api/forge/pulls/040', '/api/forge/pulls/1234567890',
      '/proposals/a/mockups/1', '/proposals/a/b/review', '/proposals/a', '/proposals/', '/auth/me', '/auth/start', '/auth/sign-out', '/', '/healthz', '/explorer/main.js', '/cornfield/house.json', '/cornfield/brand/logo.svg', '/cornfield/theme/a/b.css']) {
      expect(routeOf(p), p).toBeNull();
    }
  });
});

describe('listedWrite', () => {
  it('needs an Origin that is exactly listed, and Sec-Fetch-Site same-site or not sent', () => {
    expect(listedWrite({ origin: 'https://tasks.example.com', 'sec-fetch-site': 'same-site' }, ORIGINS)).toBe(true);
    expect(listedWrite({ origin: 'https://tasks.example.com' }, ORIGINS)).toBe(true);
    expect(listedWrite({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }, ORIGINS)).toBe(true);
    for (const site of ['cross-site', 'same-origin', 'none', 'Same-Site', '', 'same-site, cross-site']) expect(listedWrite({ origin: 'https://tasks.example.com', 'sec-fetch-site': site }, ORIGINS), site).toBe(false);
    for (const origin of [undefined, '', 'null', 'https://tasks.example.com/', 'HTTPS://TASKS.EXAMPLE.COM', 'https://tasks.example.com:443', 'http://tasks.example.com', 'https://tasks.example.com.evil.test', 'https://evil.test', 'https://tasks.example.com, https://evil.test']) {
      expect(listedWrite({ origin, 'sec-fetch-site': 'same-site' }, ORIGINS), String(origin)).toBe(false);
    }
    expect(listedWrite({ 'sec-fetch-site': 'same-site' }, ORIGINS)).toBe(false);
    expect(listedWrite({ origin: 'https://tasks.example.com', 'sec-fetch-site': 'same-site' }, [])).toBe(false);
  });
});

describe('listedReturn', () => {
  it('is the URL as parsed when its origin is listed', () => {
    expect(listedReturn('https://tasks.example.com/a?b=1#c', ORIGINS)).toBe('https://tasks.example.com/a?b=1#c');
    expect(listedReturn('HTTPS://TASKS.EXAMPLE.COM:443', ORIGINS)).toBe('https://tasks.example.com/');
    expect(listedReturn('http://localhost:5173/x', ORIGINS)).toBe('http://localhost:5173/x');
  });
  it('is null for everything else', () => {
    for (const v of [undefined, null, 5, '', '/x', '//tasks.example.com', 'https://tasks.example.com.evil.test/', 'https://tasks.example.com@evil.test/', 'https://evil.test@tasks.example.com/', 'https://tasks.example.com:8443/',
      'http://tasks.example.com/', 'https://localhost:5173/', 'http://localhost:5174/', 'http://localhost/', 'https://tasks.example.com\\@evil.test', 'javascript:alert(1)', 'https:\\\\tasks.example.com', ' https://tasks.example.com/',
      'https://tasks.example.com/\n', 'https://tasks.example.com./', `https://tasks.example.com/${'a'.repeat(1100)}`]) {
      expect(listedReturn(v, ORIGINS), String(v).slice(0, 60)).toBeNull();
    }
    expect(listedReturn('https://tasks.example.com/', [])).toBeNull();
  });
  it('absoluteUrl wants an explicit http(s) scheme and no user name', () => {
    expect(absoluteUrl('https://a.test/x')?.origin).toBe('https://a.test');
    for (const v of ['//a.test', 'a.test', 'https:a.test', 'https://', 'https://u@a.test', 'https://u:p@a.test', 'ftp://a.test', 'https://a.test/ x']) expect(absoluteUrl(v), v).toBeNull();
  });
});

describe('createEmbed with nothing listed', () => {
  it('answers nothing', () => {
    const e = createEmbed([]);
    const req = { method: 'GET', headers: { origin: 'https://tasks.example.com' }, rawHeaders: ['Origin', 'https://tasks.example.com'] };
    expect(e.enabled).toBe(false);
    expect(e.headers(req, '/topology.json')).toEqual({});
    expect(e.preflight({ ...req, method: 'OPTIONS', headers: { ...req.headers, 'access-control-request-method': 'GET' } }, '/topology.json')).toBeNull();
    expect(createEmbed().origins).toEqual([]);
  });
});
