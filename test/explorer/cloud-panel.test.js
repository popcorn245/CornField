/**
 * The cloud node panel and the Cloud / Public web layers (spec 0031 section 6, CLOUD-06): the badges and
 * the plan, the "if it's down" line, Used by grouped by when the outage bites (now, the next deploy, the next
 * renewal) with the browser's own calls marked, a long list folded into a count, the line style of each `when`,
 * and which layer an outside node belongs to. Pure: the node environment, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { loadSample, sampleRegistry } from '../helpers.js';
import { CAP } from '../../explorer/capped.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  WHEN_STYLES, whenOf, whenDash, externalLayer, planLabel, cloudBadges, cloudUsedBy, cloudPanelHtml,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/cloud-model.js';

const topology = loadSample();
const registry = sampleRegistry();

const node = (id        , type        , extra         = {}) => ({ id, type, label: id, ...extra });
const cloudflare = node('ext-cloudflare', 'external', {
  label: 'Cloudflare', kind: 'cloud', roles: ['runtime', 'account'], plan: { tier: 'free' },
  breaks: 'Now: names stop resolving. At the next renewal: no certificate.', desc: 'DNS.', file: 'topology.cloud.json',
});
const nodes = [
  cloudflare,
  node('ext-registrar', 'external', { label: 'Domain registrar', kind: 'cloud', roles: ['account'], plan: { tier: 'paid' }, breaks: 'At renewal.' }),
  node('container-caddy', 'container', { label: 'caddy' }),
  node('container-cloudflared', 'container', { label: 'cloudflared' }),
  node('machine-server-1', 'machine', { label: 'server-1' }),
  node('app-join', 'app', { label: 'join.example.test' }),
  node('svc-lib-dns', 'service', { label: 'dns' }),
];
const edges = [
  { from: 'container-caddy', to: 'ext-cloudflare', kind: 'calls', label: 'DNS-01 challenge', when: 'renew' },
  { from: 'container-cloudflared', to: 'ext-cloudflare', kind: 'calls', label: 'the tunnel' },
  { from: 'machine-server-1', to: 'ext-cloudflare', kind: 'calls', label: 'resolves *.example.test', when: 'run' },
  { from: 'app-join', to: 'ext-cloudflare', kind: 'calls', label: 'a script', side: 'browser' },
  { from: 'container-cloudflared', to: 'ext-cloudflare', kind: 'calls', label: 'image', when: 'deploy' },
  { from: 'ext-cloudflare', to: 'ext-registrar', kind: 'calls', label: 'delegated from it' },
  { from: 'store-cloud', to: 'ext-cloudflare' }, // ownership: not a user
  { from: 'svc-lib-dns', to: 'ext-cloudflare', kind: 'triggers' }, // not a call
];

describe('when an outage bites', () => {
  it('reads an edge\'s when, run when absent', () => {
    expect(whenOf({ kind: 'calls' })).toBe('run');
    expect(whenOf({ kind: 'calls', when: 'deploy' })).toBe('deploy');
    expect(whenOf({ kind: 'calls', when: 'renew' })).toBe('renew');
    expect(whenOf({ kind: 'calls', when: 'later' })).toBe('run');
  });

  it('draws run solid, deploy dashed and renew dotted, and only on a calls edge', () => {
    expect(Object.keys(WHEN_STYLES)).toEqual(['run', 'deploy', 'renew']);
    expect(whenDash({ kind: 'calls' })).toBeNull();
    const dashed = whenDash({ kind: 'calls', when: 'deploy' });
    const dotted = whenDash({ kind: 'calls', when: 'renew' });
    expect(dashed).toHaveLength(2);
    expect(dotted).toHaveLength(2);
    expect(dotted[0]).toBeLessThan(dashed[0]); // a dot is shorter than a dash
    expect(whenDash({ kind: 'flow', when: 'deploy' })).toBeNull();
    // each style has its words for the legend and the panel, and a colour
    for (const s of Object.values(WHEN_STYLES)         ) {
      expect(s.title).toMatch(/^Breaks /);
      expect(s.legend).toBeTruthy();
      expect(s.color).toMatch(/^#/);
    }
  });
});

describe('the layer of an outside node', () => {
  it('puts the public web on its own layer and every other external under Cloud', () => {
    expect(externalLayer({ type: 'external', kind: 'web' })).toBe('web');
    expect(externalLayer({ type: 'external', kind: 'cloud' })).toBe('cloud');
    expect(externalLayer({ type: 'external' })).toBe('cloud'); // a kind-less external (self-hosted, until CLOUD-03 moves it)
  });

  it('covers every external on a real map', () => {
    const layers = topology.nodes.filter((n     ) => n.type === 'external').map(externalLayer);
    expect(layers.filter((l        ) => l === 'web')).toHaveLength(1);
    expect(new Set(layers)).toEqual(new Set(['cloud', 'web']));
  });
});

describe('the badges and the plan', () => {
  it('says the kind and the roles', () => {
    expect(cloudBadges(cloudflare)).toEqual(['Cloud', 'runtime', 'account']);
    expect(cloudBadges(node('ext-public-web', 'external', { kind: 'web' }))).toEqual(['Public web', 'not cloud']);
  });

  it('says the plan in words, with its note', () => {
    expect(planLabel({ tier: 'free' })).toBe('Free');
    expect(planLabel({ tier: 'paid' })).toBe('Paid');
    expect(planLabel({ tier: 'unknown' })).toBe('Plan unknown');
    expect(planLabel({ tier: 'off' })).toBe('Off');
    expect(planLabel({ tier: 'free', note: 'Anonymous pulls' })).toBe('Free · Anonymous pulls');
    expect(planLabel({ tier: 'off', note: 'Account switched off 2026-09-28' })).toBe('Off · Account switched off 2026-09-28');
    expect(planLabel(undefined)).toBe('');
  });
});

describe('Used by', () => {
  it('groups the calls into the node by when, now first, and leaves out ownership and other kinds', () => {
    const groups = cloudUsedBy(cloudflare, nodes, edges);
    expect(groups.map((g     ) => g.when)).toEqual(['run', 'deploy', 'renew']);
    const run = groups[0];
    expect(run.title).toBe('Breaks now');
    expect(run.count).toBe(3);
    expect(groups[1].title).toBe('Breaks at the next deploy');
    expect(groups[2].title).toBe('Breaks at the next certificate renewal');
    expect(groups[2].types[0].items.map((i     ) => i.id)).toEqual(['container-caddy']);
  });

  it('lists the users by what they are, the biggest kind first, each sorted by name, and marks the browser\'s calls', () => {
    const run = cloudUsedBy(cloudflare, nodes, edges)[0];
    expect(run.types.map((t     ) => t.type)).toEqual(['app', 'container', 'machine']);
    expect(run.types.map((t     ) => t.noun)).toEqual(['app', 'container', 'machine']);
    const app = run.types[0].items[0];
    expect(app).toMatchObject({ id: 'app-join', label: 'join.example.test', via: 'a script', browser: true });
    expect(run.types[1].items[0]).toMatchObject({ id: 'container-cloudflared', browser: false });
  });

  it('leaves out a when nothing uses, and is empty for a node nothing calls', () => {
    const registrar = nodes[1];
    const groups = cloudUsedBy(registrar, nodes, edges);
    expect(groups).toHaveLength(1);
    expect(groups[0].types).toEqual([{ type: 'external', noun: 'cloud service', items: [expect.objectContaining({ id: 'ext-cloudflare' })] }]);
    expect(cloudUsedBy(node('ext-x', 'external', { kind: 'cloud' }), nodes, edges)).toEqual([]);
  });

  it('counts one user once per when, joining its labels', () => {
    const twice = [...edges, { from: 'container-cloudflared', to: 'ext-cloudflare', kind: 'calls', label: 'its health check' }];
    const run = cloudUsedBy(cloudflare, nodes, twice)[0];
    const items = run.types.find((t     ) => t.type === 'container').items;
    expect(items).toHaveLength(1);
    expect(items[0].via).toBe('the tunnel, its health check');
  });
});

describe('the panel', () => {
  const html = cloudPanelHtml(cloudflare, nodes, edges);
  const text = (h) => h.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'");
  const facts = [...html.matchAll(/<div class="hx-fact" data-corn="section"><div class="hx-fact-k">(.*?)<\/div><div class="hx-fact-v">(.*?)<\/div><\/div>(?=<div class="hx-fact"|<button|$)/g)].map((m) => [text(m[1]), text(m[2])]);
  const keys = facts.map(([k]) => k);

  it('is the node panel\'s key/value facts: the plan, the roles, the breaks line, then each when\'s users in order', () => {
    expect(keys).toEqual(['Plan', 'Roles', 'If it\'s down', 'Breaks now', 'Next deploy', 'Next renewal', 'Relies on']);
    expect(Object.fromEntries(facts)).toMatchObject({ Plan: 'Free', Roles: 'runtime, account', 'If it\'s down': 'Now: names stop resolving. At the next renewal: no certificate.' });
    expect(html.match(/class="hx-fact" data-corn="section"/g)).toHaveLength(facts.length);
  });

  it('has none of the old chrome: headings, badges, glyphs, counts, swatches, coloured styles', () => {
    for (const gone of ['hx-sec"', '<strong', 'hx-cloud-badge', 'hx-cloud-plan', 'hx-glyph', 'hx-count', 'hx-swatch', 'style=', 'hx-cloud-when', '<details', 'If it\'s down:']) expect(html, gone).not.toContain(gone);
  });

  it('shows the plan\'s note with the plan', () => {
    const hub = node('ext-hub', 'external', { kind: 'cloud', plan: { tier: 'free', note: 'Anonymous pulls' }, breaks: 'x' });
    expect(cloudPanelHtml(hub, [hub], [])).toContain('Free · Anonymous pulls');
    const bare = node('ext-bare', 'external', { kind: 'cloud', breaks: 'x' });
    expect(cloudPanelHtml(bare, [bare], [])).toContain('Plan unknown');
  });

  it('marks a call the visitor\'s browser makes, and says what a user is when a group mixes kinds', () => {
    expect(html).toMatch(/join\.example\.test<\/span> <span class="hx-cloud-browser"[^>]*>\(browser\)<\/span>/);
    expect(html.match(/\(browser\)/g)).toHaveLength(1);
    expect(Object.fromEntries(facts)['Breaks now']).toContain('machine');
  });

  it('says what the node itself relies on', () => {
    expect(Object.fromEntries(facts)['Relies on']).toContain('Domain registrar');
  });

  it('puts a quiet Play button under the facts for a cloud node, and none for the public web', () => {
    expect(html).toMatch(/<button type="button" class="hx-btn hx-btn--quiet[^"]*" data-action="play-outage" data-id="ext-cloudflare">Play: Cloudflare is down<\/button>$/);
    const web = node('ext-public-web', 'external', { kind: 'web', breaks: 'One site down.' });
    expect(cloudPanelHtml(web, [web], [])).not.toContain('play-outage');
  });

  it('says so when nothing uses it, and has no plan or roles for the public web', () => {
    const relay = node('ext-email-relay', 'external', { kind: 'cloud', roles: ['account'], plan: { tier: 'off', note: 'None today' }, breaks: 'Nothing today.' });
    const quiet = cloudPanelHtml(relay, [relay], []);
    expect(quiet).toContain('Nothing on the map uses it');
    expect(quiet).toContain('Off · None today');
    const web = node('ext-public-web', 'external', { kind: 'web', breaks: 'One site down.' });
    const out = cloudPanelHtml(web, [web], []);
    expect(out).not.toContain('Plan');
    expect(out).not.toContain('Roles');
  });

  it('folds a long list with "and n more", through capped.js', () => {
    const many = Array.from({ length: CAP + 4 }, (_, i) => node(`container-c${String(i).padStart(2, '0')}`, 'container', { label: `c${String(i).padStart(2, '0')}` }));
    const hub = node('ext-docker-hub', 'external', { label: 'Docker Hub', kind: 'cloud', roles: ['software'], plan: { tier: 'free' }, breaks: 'At the next deploy.' });
    const calls = many.map((c) => ({ from: c.id, to: hub.id, kind: 'calls', label: 'image', when: 'deploy' }));
    const out = cloudPanelHtml(hub, [hub, ...many], calls);
    expect(out).toContain('data-more=');
    expect(out).toContain('and 4 more');
    expect(out).toContain('c00');
    const short = cloudPanelHtml(hub, [hub, ...many.slice(0, CAP)], calls.slice(0, CAP));
    expect(short).not.toContain('data-more');
  });

  it('escapes what it shows', () => {
    const odd = node('ext-odd', 'external', { kind: 'cloud', roles: ['<i>'], plan: { tier: 'free', note: '<b>' }, breaks: '<script>' });
    const out = cloudPanelHtml(odd, [odd], []);
    for (const raw of ['<script>', '<b>', '<i>']) expect(out).not.toContain(raw);
  });
});

describe('on a real map (the sample repo)', () => {
  const clouds = topology.nodes.filter((n     ) => n.type === 'external' && n.kind);

  it('fills a panel for every cloud node and the public web, each with its breaks line', () => {
    expect(clouds.length).toBeGreaterThan(10);
    for (const n of clouds) {
      const out = cloudPanelHtml(n, topology.nodes, topology.edges);
      expect(out, n.id).toContain('hx-fact-k">If it&#39;s down<');
    }
  });

  it('never shows an env var name the registry matches by', () => {
    const names = registry.services.flatMap((s     ) => (s.match && s.match.env) || []).map((v        ) => v.replace(/\*$/, ''));
    expect(names.length).toBeGreaterThan(0);
    for (const n of clouds) {
      const out = cloudPanelHtml(n, topology.nodes, topology.edges);
      for (const name of names) expect(out, `${n.id} shows ${name}`).not.toContain(name);
    }
  });
});
