/**
 * The proposal format and the cloud (spec 0031 sections 1 and 8, CLOUD-01): a scenario's `down`
 * (the cloud nodes an outage scenario takes down), an added external's `kind`, `when` and `side` on an
 * added edge, what-if edits that drop a down node, and every committed proposal still validates, with
 * the 0031 proposal's two outage scenarios carrying `down`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProposal, proposalProblems, applyEdits } from '../../core/proposal.js';

import { SAMPLE, loadSample } from '../helpers.js';

/** A small map: a service calling an external with no kind yet, a cloud external, a page, a container */
const base = ()      => ({
  nodes: [
    { id: 'root', label: 'acme', type: 'root' },
    { id: 'app-a', label: 'a.example.test', type: 'app' },
    { id: 'page-home', label: '/', type: 'page' },
    { id: 'svc-geo', label: 'geo', type: 'service' },
    { id: 'container-caddy', label: 'caddy', type: 'container' },
    { id: 'ext-nominatim', label: 'Nominatim', type: 'external' },
    { id: 'ext-push', label: 'Web Push', type: 'external', kind: 'cloud', roles: ['runtime'], breaks: 'Now.', plan: { tier: 'free' } },
    { id: 'ext-public-web', label: 'Public web', type: 'external', kind: 'web' },
  ],
  edges: [
    { from: 'root', to: 'app-a' },
    { from: 'app-a', to: 'page-home' },
    { from: 'svc-geo', to: 'ext-nominatim', kind: 'calls', label: 'geo' },
  ],
});
const minimal = (over                          = {})      => ({ version: 1, title: 'T', summary: 'S', ...over });
const errorsOf = (p         , t = base()) => validateProposal(t, p);
const messages = (p         , t = base()) => errorsOf(p, t).map((e     ) => `${e.path}: ${e.message}`);
const at = (p         , where        , t = base()) => errorsOf(p, t).filter((e     ) => e.path === where);
const cloudflare = { id: 'ext-cloudflare', label: 'Cloudflare', type: 'external', kind: 'cloud', roles: ['runtime', 'account'], breaks: 'Now: names stop resolving.', plan: { tier: 'free' } };
const outage = (down         , over                          = {}) => minimal({
  nodes: { add: [cloudflare] },
  scenarios: [{ id: 'cloudflare-is-down', title: 'Cloudflare is down', down, steps: [{ node: 'ext-cloudflare', text: 'It goes down.' }] }],
  ...over,
});

describe('validateProposal: a scenario\'s down', () => {
  it('accepts cloud nodes of the map, added by the proposal, or made cloud by a change', () => {
    expect(messages(outage(['ext-cloudflare']))).toEqual([]);
    expect(messages(outage(['ext-push', 'ext-cloudflare']))).toEqual([]);
    const changed = outage(['ext-nominatim'], { nodes: { add: [cloudflare], change: [{ id: 'ext-nominatim', set: { kind: 'cloud', roles: ['runtime'], breaks: 'Now.', plan: { tier: 'free' } }, why: 'cloud' }] } });
    expect(messages(changed)).toEqual([]);
  });

  it('leaves a scenario with no down as it was', () => {
    expect(messages(minimal({ scenarios: [{ id: 's', title: 'S', steps: [{ node: 'page-home', text: 'x' }] }] }))).toEqual([]);
  });

  it('refuses a down that is not a list of node ids, is empty, or names a node twice', () => {
    expect(at(outage('ext-cloudflare'), 'scenarios[0].down')[0].message).toMatch(/list/);
    expect(at(outage([]), 'scenarios[0].down')[0].message).toMatch(/at least one/);
    expect(at(outage([7]), 'scenarios[0].down[0]')[0].message).toMatch(/node id/);
    expect(at(outage(['ext-cloudflare', 'ext-cloudflare']), 'scenarios[0].down[1]')[0].message).toMatch(/twice/);
  });

  it('refuses a node that is not a cloud external: a page, the public web, an external with no kind', () => {
    expect(at(outage(['page-home']), 'scenarios[0].down[0]')[0].message).toMatch(/page-home.*page.*cloud/);
    expect(at(outage(['ext-public-web']), 'scenarios[0].down[0]')[0].message).toMatch(/ext-public-web.*web.*cloud/);
    expect(at(outage(['ext-nominatim']), 'scenarios[0].down[0]')[0].message).toMatch(/ext-nominatim.*no kind.*cloud/);
  });

  it('marks a down node that is nowhere as dangling', () => {
    expect(at(outage(['ext-nowhere']), 'scenarios[0].down[0]')[0]).toMatchObject({ state: 'dangling', message: expect.stringMatching(/ext-nowhere/) });
  });
});

describe('validateProposal: kinds and call fields on what is added', () => {
  it('accepts an added external of either kind, or none', () => {
    expect(messages(minimal({ nodes: { add: [cloudflare, { id: 'ext-web2', label: 'Web', type: 'external', kind: 'web' }, { id: 'ext-old', label: 'Old', type: 'external' }] } }))).toEqual([]);
  });

  it('refuses an added external whose kind is neither cloud nor web', () => {
    expect(at(minimal({ nodes: { add: [{ ...cloudflare, kind: 'saas' }] } }), 'nodes.add[0].kind')[0].message).toMatch(/cloud, web/);
  });

  it('accepts when and side on added calls edges into cloud nodes', () => {
    const p = minimal({
      nodes: { add: [cloudflare] },
      edges: { add: [
        { from: 'container-caddy', to: 'ext-cloudflare', kind: 'calls', label: 'DNS-01', when: 'renew' },
        { from: 'app-a', to: 'ext-cloudflare', kind: 'calls', label: 'a script', side: 'browser' },
        { from: 'svc-geo', to: 'ext-push', kind: 'calls', label: 'push', when: 'run' },
      ] },
    });
    expect(messages(p)).toEqual([]);
  });

  it('refuses a bad when, a when into the public web, and a side off app -> external', () => {
    const p = minimal({
      nodes: { add: [cloudflare] },
      edges: { add: [
        { from: 'container-caddy', to: 'ext-cloudflare', kind: 'calls', label: 'x', when: 'soon' },
        { from: 'svc-geo', to: 'ext-public-web', kind: 'calls', label: 'x', when: 'run' },
        { from: 'container-caddy', to: 'ext-push', kind: 'calls', label: 'x', side: 'browser' },
      ] },
    });
    expect(at(p, 'edges.add[0].when')[0].message).toMatch(/run, deploy, renew/);
    expect(at(p, 'edges.add[1].when')[0].message).toMatch(/cloud/);
    expect(at(p, 'edges.add[2].side')[0].message).toMatch(/app -> external/);
  });
});

describe('applyEdits and down', () => {
  it('dropping an added cloud node drops it from every down, and an emptied down goes', () => {
    const p = outage(['ext-cloudflare', 'ext-push']);
    const next = applyEdits(p, [{ op: 'remove-node', id: 'ext-cloudflare' }]);
    expect(next.scenarios[0].down).toEqual(['ext-push']);
    const gone = applyEdits(outage(['ext-cloudflare']), [{ op: 'remove-node', id: 'ext-cloudflare' }]);
    expect(gone.scenarios[0].down).toBeUndefined();
    expect(p.scenarios[0].down).toEqual(['ext-cloudflare', 'ext-push']);
  });
});

describe('the committed proposals of the sample repo', () => {
  const real = loadSample();
  const dir = path.join(SAMPLE, 'docs/specs/proposals');
  const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.review.json'));

  it.each(files)('%s validates', (file) => {
    expect(proposalProblems(real, read(file)).errors).toEqual([]);
  });

  it('the outage scenario of the checkout proposal carries down, on a cloud node of the map', () => {
    const p = read('0002-checkout.json');
    const outages = p.scenarios.filter((s) => s.down);
    expect(outages.map((s) => s.id)).toEqual(['cloudflare-down']);
    expect(outages[0].down).toEqual(['ext-cloudflare']);
    expect(real.nodes.find((n) => n.id === 'ext-cloudflare')).toMatchObject({ type: 'external', kind: 'cloud' });
  });
});
