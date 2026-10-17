/**
 * The cloud in the schema (spec 0031 section 1, CLOUD-01): `external` gains a `kind` (cloud or
 * the public web) and a cloud node its `roles`, `breaks` and `plan`; `calls` reaches an external from
 * an app, a container, a machine or another external, and a self-hosted container from a service, an
 * endpoint or an app; `when` and `side` on a `calls` edge; `delivers` from a container to an endpoint.
 */
import { describe, it, expect } from 'vitest';
import {
  NODE_THEMES, EDGE_KINDS, EDGE_ENDS, EXTERNAL_KINDS, CLOUD_ROLES, PLAN_TIERS, CALL_WHEN, CALL_SIDES,
  endsAllowed, describeEnds, externalNodeProblems, callFieldProblems, committedNodeProblems,
} from '../../core/schema.js';
import { validateTopology } from '../../core/validate.js';
import { loadSample } from '../helpers.js';

const cloud = (over                          = {}) => ({
  id: 'ext-cloudflare', label: 'Cloudflare', type: 'external', kind: 'cloud',
  roles: ['runtime', 'account'], breaks: 'Now: names stop resolving.', plan: { tier: 'free' }, ...over,
});

describe('the external kinds and the cloud fields', () => {
  it('names the two kinds, the three roles, the four plan tiers, when and side', () => {
    expect(EXTERNAL_KINDS).toEqual(['cloud', 'web']);
    expect(CLOUD_ROLES).toEqual(['runtime', 'software', 'account']);
    expect(PLAN_TIERS).toEqual(['free', 'paid', 'unknown', 'off']);
    expect(CALL_WHEN).toEqual(['run', 'deploy', 'renew']);
    expect(CALL_SIDES).toEqual(['browser']);
  });

  it('adds no node type and no edge kind (D1, D2)', () => {
    expect(NODE_THEMES.cloud).toBeUndefined();
    expect(EDGE_KINDS).toEqual(['flow', 'reads', 'writes', 'uses', 'extends', 'calls', 'triggers', 'delivers', 'runs-on']);
  });

  it('accepts a cloud node with roles, breaks and a plan, and the public web with no roles or plan', () => {
    expect(externalNodeProblems(cloud())).toEqual([]);
    expect(externalNodeProblems(cloud({ plan: { tier: 'off', note: 'none today' } }))).toEqual([]);
    expect(externalNodeProblems({ id: 'ext-public-web', label: 'Public web', type: 'external', kind: 'web', breaks: 'One site down.' })).toEqual([]);
  });

  it('refuses a kind that is not one of the two', () => {
    expect(externalNodeProblems(cloud({ kind: 'saas' })).join()).toMatch(/kind "saas".*cloud, web/);
  });

  it('allows an external with no kind until the registry draws them all, and refuses it when asked to', () => {
    const bare = { id: 'ext-nextcloud', label: 'Nextcloud', type: 'external' };
    expect(externalNodeProblems(bare)).toEqual([]);
    expect(externalNodeProblems(bare, { requireKind: true }).join()).toMatch(/ext-nextcloud.*no "kind"/);
  });

  it('holds a cloud node to its roles, its breaks line and its plan', () => {
    expect(externalNodeProblems(cloud({ roles: undefined })).join()).toMatch(/roles/);
    expect(externalNodeProblems(cloud({ roles: [] })).join()).toMatch(/roles/);
    expect(externalNodeProblems(cloud({ roles: ['runtime', 'hosting'] })).join()).toMatch(/role "hosting"/);
    expect(externalNodeProblems(cloud({ roles: ['runtime', 'runtime'] })).join()).toMatch(/twice/);
    expect(externalNodeProblems(cloud({ breaks: '' })).join()).toMatch(/breaks/);
    expect(externalNodeProblems(cloud({ plan: undefined })).join()).toMatch(/plan/);
    expect(externalNodeProblems(cloud({ plan: { tier: 'cheap' } })).join()).toMatch(/tier "cheap".*free, paid, unknown, off/);
    expect(externalNodeProblems(cloud({ plan: { tier: 'paid', price: 12 } })).join()).toMatch(/price/);
    expect(externalNodeProblems(cloud({ plan: { tier: 'paid', note: 3 } })).join()).toMatch(/note/);
  });

  it('keeps roles and a plan off the public web and off an external with no kind', () => {
    expect(externalNodeProblems({ id: 'ext-public-web', label: 'Public web', type: 'external', kind: 'web', roles: ['runtime'] }).join()).toMatch(/roles.*cloud/);
    expect(externalNodeProblems({ id: 'ext-public-web', label: 'Public web', type: 'external', kind: 'web', plan: { tier: 'free' } }).join()).toMatch(/plan.*cloud/);
    expect(externalNodeProblems({ id: 'ext-x', label: 'X', type: 'external', plan: { tier: 'free' } }).join()).toMatch(/plan.*cloud/);
  });

  it('leaves other node types alone, and is part of what is wrong with a committed node', () => {
    expect(externalNodeProblems({ id: 'svc-x', type: 'service', kind: 'timer' })).toEqual([]);
    expect(committedNodeProblems(cloud({ kind: 'saas' })).join()).toMatch(/saas/);
    expect(committedNodeProblems(cloud())).toEqual([]);
  });
});

describe('the widened ends', () => {
  it('lets calls reach an external from a service, an endpoint, an app, a container, a machine or another external', () => {
    for (const from of ['service', 'page', 'app', 'container', 'machine', 'external']) expect(endsAllowed(EDGE_ENDS.calls, from, 'external'), from).toBe(true);
    for (const from of ['table', 'stack', 'persona', 'device', 'store']) expect(endsAllowed(EDGE_ENDS.calls, from, 'external'), from).toBe(false);
  });

  it('keeps the old calls ends, and lets a service, an endpoint or an app reach a self-hosted container', () => {
    for (const [a, b] of [['service', 'service'], ['page', 'service'], ['tool', 'page'], ['service', 'container'], ['page', 'container'], ['app', 'container']]) {
      expect(endsAllowed(EDGE_ENDS.calls, a, b), `${a} -> ${b}`).toBe(true);
    }
    expect(endsAllowed(EDGE_ENDS.calls, 'container', 'container')).toBe(false);
    expect(endsAllowed(EDGE_ENDS.calls, 'external', 'service')).toBe(false);
  });

  it('lets delivers go container -> endpoint (the self-hosted webhooks), beside external -> endpoint and device -> container', () => {
    expect(EDGE_ENDS.delivers).toEqual([['external', 'page'], ['device', 'container'], ['container', 'page']]);
    expect(describeEnds(EDGE_ENDS.delivers)).toBe('external -> page, device -> container, or container -> page');
  });
});

describe('when and side on a calls edge', () => {
  const ext = (kind         ) => ({ type: 'external', ...(kind ? { kind } : {}) });
  const node = (type        ) => ({ type });

  it('accepts each when on a calls edge into a cloud node, or into an external with no kind yet', () => {
    for (const when of CALL_WHEN) expect(callFieldProblems({ kind: 'calls', when }, node('container'), ext('cloud')), when).toEqual([]);
    expect(callFieldProblems({ kind: 'calls', when: 'deploy' }, node('container'), ext())).toEqual([]);
    expect(callFieldProblems({ kind: 'calls' }, node('service'), ext('cloud'))).toEqual([]);
  });

  it('refuses an unknown when, a when off a calls edge, and a when into the public web or a container', () => {
    expect(callFieldProblems({ kind: 'calls', when: 'later' }, node('container'), ext('cloud')).join()).toMatch(/when "later".*run, deploy, renew/);
    expect(callFieldProblems({ kind: 'delivers', when: 'run' }, ext('cloud'), node('page')).join()).toMatch(/when.*calls/);
    expect(callFieldProblems({ kind: 'calls', when: 'run' }, node('service'), ext('web')).join()).toMatch(/when.*cloud/);
    expect(callFieldProblems({ kind: 'calls', when: 'run' }, node('service'), node('container')).join()).toMatch(/when.*cloud/);
  });

  it('accepts side browser on an app -> external calls edge, and nothing else', () => {
    expect(callFieldProblems({ kind: 'calls', side: 'browser' }, node('app'), ext('cloud'))).toEqual([]);
    expect(callFieldProblems({ kind: 'calls', side: 'server' }, node('app'), ext('cloud')).join()).toMatch(/side "server".*browser/);
    expect(callFieldProblems({ kind: 'calls', side: 'browser' }, node('container'), ext('cloud')).join()).toMatch(/side.*app -> external/);
    expect(callFieldProblems({ side: 'browser' }, node('app'), ext('cloud')).join()).toMatch(/side.*calls/);
  });
});

describe('topology.js validate and the cloud', () => {
  const real = loadSample();
  const theme = (type        ) => ({ color: NODE_THEMES[type].color, r: NODE_THEMES[type].r });
  const app = real.nodes.find((n     ) => n.type === 'app').id;
  const machine = real.nodes.find((n     ) => n.type === 'machine').id;
  const container = real.nodes.find((n     ) => n.type === 'container').id;
  const endpoint = real.nodes.find((n     ) => n.type === 'page' && Array.isArray(n.methods)).id;
  const extra = {
    nodes: [
      { ...cloud(), ...theme('external'), desc: 'DNS.' },
      { id: 'ext-registrar', label: 'Domain registrar', type: 'external', kind: 'cloud', roles: ['account'], breaks: 'At renewal.', plan: { tier: 'paid' }, ...theme('external'), desc: 'Where the domain is registered.' },
      { id: 'ext-public-web', label: 'Public web', type: 'external', kind: 'web', breaks: 'One site down.', ...theme('external'), desc: 'Any public page.' },
    ],
    edges: [
      { from: container, to: 'ext-cloudflare', kind: 'calls', label: 'DNS-01', when: 'renew' },
      { from: machine, to: 'ext-cloudflare', kind: 'calls', label: 'resolves *.example.test' },
      { from: app, to: 'ext-cloudflare', kind: 'calls', label: 'a script', side: 'browser' },
      { from: 'ext-cloudflare', to: 'ext-registrar', kind: 'calls', label: 'the zone is delegated to it' },
      { from: container, to: endpoint, kind: 'delivers', label: 'a webhook' },
    ],
  };
  // The registry draws these three on the real map now (CLOUD-02): the test's own versions stand in for them
  const replaced = new Set(extra.nodes.map((n) => n.id));
  const withCloud = (more                                         = {}) => validateTopology({
    ...real,
    nodes: [...real.nodes.filter((n     ) => !replaced.has(n.id)), ...extra.nodes, ...(more.nodes || [])],
    edges: [...real.edges, ...extra.edges, ...(more.edges || [])],
  }).filter((e        ) => !e.startsWith('[OpenCollection]'));

  it('accepts cloud nodes, the public web and the widened edges', () => {
    expect(withCloud()).toEqual([]);
  });

  it('refuses calls between ends it does not allow, naming the allowed ones', () => {
    expect(withCloud({ edges: [{ from: 'ext-cloudflare', to: container, kind: 'calls', label: 'x' }] }).join()).toMatch(/must go service -> service.*external -> external/);
  });

  it('refuses a bad kind, a bad plan, a bad when and a misplaced side', () => {
    const errors = withCloud({
      nodes: [{ ...cloud({ id: 'ext-bad', kind: 'saas' }), ...theme('external'), desc: 'x' }, { ...cloud({ id: 'ext-cheap', plan: { tier: 'cheap' } }), ...theme('external'), desc: 'x' }],
      edges: [
        { from: machine, to: 'ext-registrar', kind: 'calls', label: 'x', when: 'later' },
        { from: container, to: 'ext-registrar', kind: 'calls', label: 'x', side: 'browser' },
      ],
    }).join('\n');
    expect(errors).toMatch(/ext-bad.*saas/);
    expect(errors).toMatch(/ext-cheap.*cheap/);
    expect(errors).toMatch(/when "later"/);
    expect(errors).toMatch(/side.*app -> external/);
  });
});
