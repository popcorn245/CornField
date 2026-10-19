/**
 * @vitest-environment node
 *
 * The OpenAPI deriver (plugins/openapi): an API's endpoints from its OpenAPI, Swagger or OpenCollection
 * file, as page nodes with their methods under the API's app.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import openapi, { openApiEndpoints, collectionEndpoints, requestPath, serverPath, specKind } from '../../plugins/openapi/index.js';
import { deriveTopology } from '../../core/derive.js';
import { planSync } from '../../core/sync.js';
import { loadConfig, loadDerivers } from '../../core/config.js';
import { validateRepo } from '../../core/validate.js';
import { CORNFIELD } from '../helpers.js';

const FIXTURE = path.join(CORNFIELD, 'test', 'fixtures', 'openapi');
const made = [];
/** A repo on disk from { 'path': text } */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cornfield-openapi-'));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof text === 'string' ? text : JSON.stringify(text));
  }
  return root;
}
afterAll(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

const derive = (root, options = {}, { nodes = [], map = null } = {}) => {
  const before = { name: 'before', contract: 1, derive: () => ({ nodes, edges: [] }) };
  return deriveTopology({ root, derivers: [{ deriver: before }, { deriver: openapi, options }], map });
};
const pages = (out) => out.nodes.filter((n) => n.type === 'page').map((n) => `${n.id} ${n.label} ${n.methods.join(',')}`);

describe('openApiEndpoints', () => {
  it('reads each path with its methods in order, under the first server path', () => {
    const doc = {
      openapi: '3.0.3', servers: [{ url: 'https://api.example.com/v1/' }],
      paths: { '/orders': { post: {}, get: { summary: 'List orders' }, parameters: [] }, '/orders/{id}': { delete: {}, get: {} }, '/empty': { parameters: [] } },
    };
    expect(openApiEndpoints(doc)).toEqual([
      { path: '/v1/orders', key: '/orders', methods: ['GET', 'POST'], summary: 'List orders' },
      { path: '/v1/orders/{id}', key: '/orders/{id}', methods: ['GET', 'DELETE'], summary: null },
    ]);
    expect(openApiEndpoints(doc, { prefix: '' }).map((e) => e.path)).toEqual(['/orders', '/orders/{id}']);
  });

  it("takes Swagger 2.0's basePath, and a templated or relative server", () => {
    expect(openApiEndpoints({ swagger: '2.0', basePath: '/api', paths: { '/': { get: {} } } }).map((e) => e.path)).toEqual(['/api']);
    expect(serverPath('{scheme}://{host}/v2')).toBe('/v2');
    expect(serverPath('/relative/')).toBe('/relative');
    expect(serverPath('https://api.example.com')).toBe('');
  });
});

describe('collectionEndpoints', () => {
  it('reads every request in nested folders, without the base URL variable, with :id and {{id}} as {id}', () => {
    const doc = {
      opencollection: '1.0.0', info: { name: 'Shop' },
      items: [
        { info: { name: 'List orders', type: 'http' }, http: { method: 'GET', url: '{{baseUrl}}/orders?page=2' } },
        { info: { name: 'Orders', type: 'folder' }, items: [
          { info: { name: 'One order' }, http: { method: 'get', url: '{{baseUrl}}/orders/:id' } },
          { info: { name: 'Delete' }, http: { method: 'DELETE', url: 'https://api.example.com/orders/{{orderId}}' } },
          { name: 'Create', request: { method: 'POST', url: { raw: '{{host}}/orders' } } },
        ] },
        { info: { name: 'A script' }, script: 'nothing' },
      ],
    };
    expect(collectionEndpoints(doc)).toEqual([
      { path: '/orders', key: '/orders', methods: ['GET', 'POST'], summary: 'List orders' },
      { path: '/orders/{id}', key: '/orders/{id}', methods: ['GET'], summary: 'One order' },
      { path: '/orders/{orderId}', key: '/orders/{orderId}', methods: ['DELETE'], summary: 'Delete' },
    ]);
    expect(requestPath('{{baseUrl}}')).toBe('/');
    expect(specKind(doc)).toBe('collection');
    expect(specKind({ openapi: '3.1.0', paths: {} })).toBe('openapi');
    expect(specKind({ name: 'x' })).toBeNull();
  });
});

describe('the openapi deriver', () => {
  const spec = { openapi: '3.1.0', info: { title: 'Shop API' }, servers: [{ url: '/api' }], paths: { '/orders': { get: { summary: 'Every order' }, post: {} }, '/orders/{id}': { get: {} } } };

  it("finds the one spec, makes the app when no one has, and its pages under it", async () => {
    const out = await derive(repo({ 'docs/openapi.json': spec }));
    expect(out.nodes.find((n) => n.type === 'app')).toEqual({ id: 'app-api', label: 'Shop API', type: 'app', file: 'docs/openapi.json' });
    expect(pages(out)).toEqual(['page-api-orders /api/orders GET,POST', 'page-api-orders-id /api/orders/{id} GET']);
    expect(out.nodes.find((n) => n.id === 'page-api-orders').desc).toBe('GET · POST /api/orders: Every order');
    expect(out.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['root>app-api', 'app-api>page-api-orders', 'app-api>page-api-orders-id']);
    expect(out).toMatchObject({ ownedIds: ['app-api'], pageOwners: ['app-api'] });
  });

  it("puts the pages under an app another deriver or the map has, and leaves that app alone", async () => {
    const root = repo({ 'api/openapi.yaml': 'openapi: 3.0.0\ninfo: { title: X }\npaths:\n  /health:\n    get: {}\n' });
    const byOther = await derive(root, { app: 'app-backend' }, { nodes: [{ id: 'app-backend', type: 'app', label: 'backend.example.com' }] });
    expect(byOther.nodes.map((n) => n.id)).toEqual(['app-backend', 'page-backend-health']);
    const onMap = await derive(root, {}, { map: { nodes: [{ id: 'app-api', type: 'app', label: 'api.example.com', file: 'api' }], edges: [] } });
    expect(onMap.nodes.map((n) => n.id)).toEqual(['page-api-health']);
    expect(onMap.ownedIds).toEqual([]);
  });

  it('keeps its own app on the next sync, and removes an endpoint gone from the spec', async () => {
    const root = repo({ 'openapi.json': spec });
    const first = planSync({ nodes: [{ id: 'root', type: 'root', label: 'r' }], edges: [] }, await derive(root)).next;
    fs.writeFileSync(path.join(root, 'openapi.json'), JSON.stringify({ ...spec, paths: { '/orders': spec.paths['/orders'] } }));
    const { changes } = planSync(first, await derive(root, {}, { map: first }));
    expect(changes).toEqual(['remove page page-api-orders-id (/api/orders/{id})', 'drop hand-written edge app-api|page-api-orders-id|own: an end no longer exists']);
  });

  it('reads the specs the options name, each under its app, and asks when it finds several', async () => {
    const root = repo({ 'a/openapi.json': spec, 'b/swagger.json': { swagger: '2.0', info: { title: 'B' }, paths: { '/ping': { get: {} } } } });
    const several = await derive(root);
    expect(several.nodes).toEqual([]);
    expect(several.warnings[0]).toMatch(/2 API description files \(a\/openapi.json, b\/swagger.json\); name the ones to draw/);
    const named = await derive(root, { specs: [{ file: 'a/openapi.json', app: 'app-shop', prefix: '' }, { file: 'b/swagger.json', app: 'app-b' }] });
    expect(pages(named)).toEqual(['page-shop-orders /orders GET,POST', 'page-shop-orders-id /orders/{id} GET', 'page-b-ping /ping GET']);
  });

  it('says what is wrong: a missing file, broken JSON, a file that is no API description', async () => {
    const root = repo({ 'openapi.json': '{', 'other.json': { hello: 1 } });
    await expect(derive(root, { file: 'nope.yaml' })).rejects.toThrow(/API description nope.yaml does not exist/);
    await expect(derive(root, { file: 'openapi.json' })).rejects.toThrow(/openapi.json is not valid JSON/);
    await expect(derive(root, { file: 'other.json' })).rejects.toThrow(/neither an OpenAPI document/);
    expect(await derive(repo({ 'README.md': 'no API' }))).toMatchObject({ nodes: [], edges: [] });
  });
});

describe('the openapi fixture repo (only an OpenAPI file)', () => {
  it('gets its endpoints on the map, and its committed map matches', async () => {
    const config = await loadConfig(FIXTURE, { env: {} });
    const derivers = await loadDerivers(config);
    const map = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'topology.json'), 'utf8'));
    const derived = await deriveTopology({ root: FIXTURE, config, derivers, map });
    expect(pages(derived)).toEqual(['page-api-items /api/v1/items GET,POST', 'page-api-items-id /api/v1/items/{id} GET,PATCH,DELETE', 'page-api-shopping-list /api/v1/shopping-list PUT']);
    expect(planSync(map, derived).changes).toEqual([]);
    expect((await validateRepo({ config, derivers })).errors).toEqual([]);
  });
});
