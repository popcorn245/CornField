/**
 * @vitest-environment node
 *
 * core/routes.js is the table the map's hub routes are derived from. This keeps it honest
 * against the handler in proposals.js: every route in it is answered, for every method it lists, and for
 * any other method the handler says 405 with exactly those methods in `Allow`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error plain JS module, no declarations
import { serveProposals } from '../../server/proposals.js';
import { whereOf } from './where.js';
// @ts-expect-error plain JS module, no declarations
import { PROPOSAL_ROUTES } from '../../core/routes.js';

describe('hub-routes.js against proposals.js', () => {
  let root        ;
  let server             ;
  let port        ;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-routes-'));
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify({ nodes: [{ id: 'root', label: 'root', type: 'root' }], edges: [] }));
    server = http.createServer((req, res) => {
      const url = new URL(req.url , 'http://localhost');
      if (!serveProposals(req, res, decodeURIComponent(url.pathname), url, whereOf(root))) { res.writeHead(418); res.end('not a proposal route'); }
    });
    await new Promise      ((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address()                   ).port;
  });

  afterAll(async () => {
    await new Promise      ((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const call = (method        , route        ) =>
    fetch(`http://127.0.0.1:${port}${route.replace('[slug]', '0013-nothing')}`, { method });

  it('lists the three routes of the proposal API', () => {
    expect(PROPOSAL_ROUTES.map((r                   ) => r.route)).toEqual(['/proposals', '/proposals/[slug].json', '/proposals/[slug]/review']);
  });

  it.each(PROPOSAL_ROUTES.map((r                                      ) => [r.route, r.methods]))('%s answers every method it lists, and only those', async (route        , methods          ) => {
    for (const method of methods) {
      // PUT needs a same-origin body to get anywhere; being refused for that is still being answered
      const res = await call(method, route);
      expect(res.status, `${method} ${route}`).not.toBe(405);
      expect(res.status, `${method} ${route}`).not.toBe(418);
    }
    const res = await call('DELETE', route);
    expect(res.status).toBe(405);
    const allow = res.headers.get('allow') .split(/,\s*/).filter((m) => m !== 'HEAD').sort();
    expect(allow).toEqual([...methods].sort());
  });

  it('names a write only on a route that accepts PUT', () => {
    for (const r of PROPOSAL_ROUTES                                                            ) {
      expect(Boolean(r.writes), r.route).toBe(r.methods.includes('PUT'));
    }
  });
});
