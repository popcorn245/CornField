import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCloud, matchEvidence, cloudEdges, deriveCloud, cloudNodeProblems, claims, CLOUD_FILE, CLOUD_STORE_ID, EVIDENCE_KINDS } from '../../core/cloud.js';
import { externalNodeProblems } from '../../core/schema.js';
import { deriveTopology } from '../../core/derive.js';
import { validateCloudNodes } from '../../core/validate.js';
import { loadConfig, loadDerivers } from '../../core/config.js';
import { SAMPLE as ROOT, loadSample as loadTopology } from '../helpers.js';
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, CLOUD_FILE), 'utf8'));


const service = (extra      = {})      => ({
  id: 'geocoder', label: 'Geocoder', roles: ['runtime'], desc: 'Address search', breaks: 'Now: address search is empty.',
  plan: { tier: 'free' }, match: { libs: ['lib/geo.ts'], hosts: ['geo.example.com'] }, ...extra
});
const file = (...services       )      => ({ version: 1, services });
const piece = (kind        , value         , extra      = {})      => ({ match: { kind, value }, from: 'svc-geo', label: 'geo', file: 'lib/geo.ts', ...extra });
const errorsOf = (f         , opts      = {}) => validateCloud(f, opts).errors            ;
const memory = (f         ) => ({ read: () => JSON.stringify(f), exists: (rel        ) => rel === CLOUD_FILE });

describe('validateCloud: the file (rule 1)', () => {
  it('accepts the committed file', () => {
    expect(errorsOf(committed)).toEqual([]);
  });

  it('wants version 1, a list of services and no unknown keys', () => {
    expect(errorsOf(null)[0]).toMatch(/must be an object/);
    expect(errorsOf({ ...file(service()), version: 2 })).toEqual([expect.stringMatching(/^version: must be 1/)]);
    expect(errorsOf({ version: 1, services: [] })).toEqual([expect.stringMatching(/^services: must be a list/)]);
    expect(errorsOf({ ...file(service()), extra: 1 })[0]).toMatch(/unknown key "extra"/);
    expect(errorsOf(file(service({ price: 3 }))).join()).toMatch(/unknown key "price"/);
  });

  it('wants a kebab id, unique, never the public web', () => {
    expect(errorsOf(file(service({ id: 'Geo' }))).join()).toMatch(/"id" must be lower-case words/);
    expect(errorsOf(file(service(), service({ match: { hosts: ['b.example.com'] } }))).join()).toMatch(/duplicate id "geocoder"/);
    expect(errorsOf(file(service({ id: 'public-web' }))).join()).toMatch(/public web's node/);
  });

  it('wants a label, a desc and a breaks line', () => {
    for (const key of ['label', 'desc', 'breaks']) expect(errorsOf(file(service({ [key]: ' ' }))).join()).toMatch(new RegExp(`"${key}"`));
  });

  it('wants roles from the three, each once', () => {
    expect(errorsOf(file(service({ roles: [] }))).join()).toMatch(/needs "roles"/);
    expect(errorsOf(file(service({ roles: ['runtime', 'hosting'] }))).join()).toMatch(/role "hosting"/);
    expect(errorsOf(file(service({ roles: ['runtime', 'runtime'] }))).join()).toMatch(/names a role twice/);
  });

  it('wants a plan with a tier from the four, a note in words, and never a price', () => {
    expect(errorsOf(file(service({ plan: undefined }))).join()).toMatch(/needs a "plan"/);
    expect(errorsOf(file(service({ plan: { tier: 'gold' } }))).join()).toMatch(/plan tier "gold"/);
    expect(errorsOf(file(service({ plan: { tier: 'paid', note: '' } }))).join()).toMatch(/note/);
    expect(errorsOf(file(service({ plan: { tier: 'paid', price: 5 } }))).join()).toMatch(/never a price/);
    for (const tier of ['free', 'paid', 'unknown', 'off']) expect(errorsOf(file(service({ plan: { tier } })))).toEqual([]);
  });

  it('wants match lists of words under known keys, bare hosts, and tailnet only as true', () => {
    expect(errorsOf(file(service({ match: { domains: ['x'] } }))).join()).toMatch(/unknown key "domains"/);
    expect(errorsOf(file(service({ match: { hosts: [] } }))).join()).toMatch(/match.hosts" must be a list/);
    expect(errorsOf(file(service({ match: { hosts: ['a.example.com', 'a.example.com'] } }))).join()).toMatch(/same value twice/);
    expect(errorsOf(file(service({ match: { hosts: ['https://a.example.com'] } }))).join()).toMatch(/not a bare host/);
    expect(errorsOf(file(service({ match: { tailnet: 'yes' } }))).join()).toMatch(/tailnet" can only be true/);
    expect(errorsOf(file(service({ match: { tailnet: true, hosts: ['*.example.com', '1.1.1.1'] } })))).toEqual([]);
  });

  it('wants each use to have a from, a label, a why and a known when', () => {
    const use = { from: 'machine-a', label: 'resolves names', why: 'Not in any file' };
    expect(errorsOf(file(service({ uses: [use] })))).toEqual([]);
    expect(errorsOf(file(service({ uses: [] }))).join()).toMatch(/"uses" must be a list/);
    expect(errorsOf(file(service({ uses: [{ ...use, why: undefined }] }))).join()).toMatch(/needs a "why"/);
    expect(errorsOf(file(service({ uses: [{ ...use, when: 'later' }] }))).join()).toMatch(/when "later"/);
    expect(errorsOf(file(service({ uses: [{ ...use, extra: 1 }] }))).join()).toMatch(/unknown key "extra"/);
  });

  it('checks the public web and the links', () => {
    expect(errorsOf({ ...file(service()), web: { label: 'Public web', desc: 'Any page', plan: { tier: 'free' } } }).join()).toMatch(/not cloud/);
    expect(errorsOf({ ...file(service()), web: { label: 'Public web' } }).join()).toMatch(/web: needs a "desc"/);
    expect(errorsOf({ ...file(service()), links: [{ host: 'www.example.org' }] }).join()).toMatch(/needs a "why"/);
    expect(errorsOf({ ...file(service()), links: [{ host: 'www.example.org/page', why: 'A link' }] }).join()).toMatch(/bare host name/);
  });
});

describe('validateCloud: privacy (rule 6)', () => {
  it('refuses an email address or a handle', () => {
    expect(errorsOf(file(service({ desc: 'Run by someone@example.com' }))).join()).toMatch(/"@"/);
  });

  it('refuses a run of six or more digits', () => {
    expect(errorsOf(file(service({ plan: { tier: 'paid', note: 'Account 1234567' } }))).join()).toMatch(/six or more digits/);
    expect(errorsOf(file(service({ desc: 'Since 2026-09-28, over 12345 requests' })))).toEqual([]);
  });

  it('refuses a URL with a path, with or without the scheme, but not a repo path', () => {
    expect(errorsOf(file(service({ desc: 'Loads https://cdn.example.com/npm/x' }))).join()).toMatch(/URL with a path/);
    expect(errorsOf(file(service({ desc: 'Loads cdn.example.com/npm/x' }))).join()).toMatch(/URL with a path/);
    expect(errorsOf(file(service({ desc: 'Read by apps/api.example.test/lib/geo.ts at cdn.example.com' })))).toEqual([]);
  });

  it('refuses a key that would hold an account detail', () => {
    for (const key of ['email', 'user', 'account_id', 'token']) expect(errorsOf(file(service({ [key]: 'x' }))).join()).toMatch(new RegExp(`key "${key}"`));
  });
});

describe('validateCloud: who claims what (rule 4)', () => {
  it('refuses a match value claimed by two entries, or by an entry and the links', () => {
    const two = errorsOf(file(service(), service({ id: 'other', match: { hosts: ['geo.example.com'] } })));
    expect(two).toEqual([expect.stringMatching(/match.hosts "geo.example.com".*geocoder and other/)]);
    expect(errorsOf({ ...file(service()), links: [{ host: 'geo.example.com', why: 'A link' }] }).join()).toMatch(/geocoder and links/);
  });

  it('refuses a use from a node the map does not have (the file\'s own nodes count)', () => {
    const f = file(service({ uses: [{ from: 'machine-gone', label: 'x', why: 'y' }] }), service({ id: 'registrar', match: undefined, uses: [{ from: 'ext-geocoder', label: 'delegated', why: 'An account' }] }));
    expect(errorsOf(f, { nodeIds: ['svc-geo'] })).toEqual([expect.stringMatching(/"machine-gone", which is not a node/)]);
    expect(errorsOf(f)).toEqual([]);
  });
});

describe('the matcher', () => {
  it('claims hosts exactly or under a wildcard, env by name or prefix, images and actions by prefix', () => {
    expect(claims('hosts', 'a.example.com', 'a.example.com')).toBe(true);
    expect(claims('hosts', '*.example.com', 'b.a.example.com')).toBe(true);
    expect(claims('hosts', '*.example.com', 'example.com')).toBe(false);
    expect(claims('env', 'VAPID_*', 'VAPID_PUBLIC_KEY')).toBe(true);
    expect(claims('env', 'VAPID', 'VAPID_PUBLIC_KEY')).toBe(false);
    expect(claims('images', 'ghcr.io/', 'ghcr.io/x/y')).toBe(true);
    expect(claims('images', 'cloudflare/cloudflared', 'cloudflare/cloudflared')).toBe(true);
    expect(claims('actions', 'actions/', 'actions/checkout')).toBe(true);
    expect(claims('registries', 'docker.io/', 'docker.io/')).toBe(true);
    expect(claims('tailnet', true, 'server-1')).toBe(true);
  });

  it('finds the claimant of each piece, and the pieces nobody claims', () => {
    const f = { ...file(service()), web: { label: 'Public web', desc: 'Any page', match: { libs: ['lib/safe-fetch.ts'] } }, links: [{ host: 'www.example.org', why: 'A link' }] };
    const { claimed, unclaimed } = matchEvidence(f, [piece('lib', 'lib/geo.ts'), piece('lib', 'lib/safe-fetch.ts'), piece('host', 'www.example.org'), piece('host', 'nobody.example.com')]);
    expect(claimed.map((c     ) => c.id)).toEqual(['geocoder', 'public-web', null]);
    expect(unclaimed.map((p     ) => p.match.value)).toEqual(['nobody.example.com']);
  });

  it('draws one calls edge per (from, entry), labels joined, the strongest when, browser only when every piece says so', () => {
    const f = file(service({ match: { libs: ['lib/geo.ts'], hosts: ['geo.example.com'], caddy: ['acme'] } }));
    const { claimed } = matchEvidence(f, [
      piece('caddy', 'acme', { from: 'container-caddy', label: 'certificates', when: 'renew' }),
      piece('host', 'geo.example.com', { from: 'container-caddy', label: 'resolvers' }),
      piece('host', 'geo.example.com', { from: 'app-x', label: 'fonts', side: 'browser' }),
      piece('lib', 'lib/geo.ts', { from: 'app-x', label: 'fonts', side: 'browser' }),
      piece('caddy', 'acme', { from: 'container-y', label: 'pull', when: 'deploy' })
    ]);
    const edges = cloudEdges(f, claimed);
    expect(edges).toEqual([
      { from: 'container-caddy', to: 'ext-geocoder', kind: 'calls', status: 'live', label: 'certificates · resolvers' },
      { from: 'app-x', to: 'ext-geocoder', kind: 'calls', status: 'live', label: 'fonts', side: 'browser' },
      { from: 'container-y', to: 'ext-geocoder', kind: 'calls', status: 'live', label: 'pull', when: 'deploy' }
    ]);
  });

  it('draws a webhook as the service delivering to the endpoint, a use as a calls edge, and a link as nothing', () => {
    const f = { ...file(service({ id: 'tracker', match: { webhooks: ['tracker'] }, uses: [{ from: 'machine-a', label: 'by hand', when: 'deploy', why: 'Set in a UI' }] })), links: [{ host: 'www.example.org', why: 'A link' }] };
    const { claimed } = matchEvidence(f, [{ match: { kind: 'webhook', value: 'tracker' }, to: 'page-hook', label: 'tracker webhook', file: 'routes/webhooks.ts' }, piece('host', 'www.example.org')]);
    expect(cloudEdges(f, claimed)).toEqual([
      { from: 'ext-tracker', to: 'page-hook', kind: 'delivers', status: 'live', label: 'tracker webhook' },
      { from: 'machine-a', to: 'ext-tracker', kind: 'calls', status: 'live', label: 'by hand', when: 'deploy' }
    ]);
  });
});

describe('evidence that is described but not drawn (CLOUD-04)', () => {
  it('draws nothing for a piece with drawn: false, and does not count it as a use', () => {
    const f = file(service({ match: { hosts: ['geo.example.com'] } }));
    const link = piece('host', 'geo.example.com', { from: 'app-x', drawn: false });
    expect(cloudEdges(f, matchEvidence(f, [link]).claimed)).toEqual([]);
    expect(errorsOf(f, { evidence: [link] }).join()).toMatch(/nothing uses ext-geocoder/);
    expect(errorsOf(f, { evidence: [{ ...link, match: { kind: 'host', value: 'other.example.com' } }] }).join()).toMatch(/reaches host "other\.example\.com"; no entry/);
  });
});

describe('validateCloud: against the evidence (rules 2, 3, 5)', () => {
  it('fails on evidence no entry matches, naming the file and what it found', () => {
    const { errors } = validateCloud(file(service()), { evidence: [piece('lib', 'lib/geo.ts'), piece('host', 'world.openfoodfacts.org', { file: 'routes/inventory-upc.ts' })] });
    expect(errors).toEqual([expect.stringMatching(/^routes\/inventory-upc.ts: reaches host "world.openfoodfacts.org"; no entry in topology.cloud.json matches it. .*or to links/)]);
  });

  it('fails when the code names the service and the registry puts it elsewhere', () => {
    const { errors } = validateCloud(file(service()), { evidence: [piece('lib', 'lib/geo.ts', { entry: 'maps' })] });
    expect(errors).toEqual([expect.stringMatching(/names lib "lib\/geo.ts" as "maps", but topology.cloud.json puts it under "geocoder"/)]);
  });

  it('fails on an entry nothing uses, unless it has uses or is off', () => {
    const lonely = validateCloud(file(service(), service({ id: 'pypi', match: { packages: ['pypi'] } })), { evidence: [piece('lib', 'lib/geo.ts')] });
    expect(lonely.errors).toEqual([expect.stringMatching(/nothing uses ext-pypi any more/)]);
    const used = validateCloud(file(service(), service({ id: 'isp', match: undefined, roles: ['account'], uses: [{ from: 'svc-geo', label: 'internet', why: 'An account' }] })), { evidence: [piece('lib', 'lib/geo.ts')] });
    expect(used.errors).toEqual([]);
    const off = validateCloud(file(service(), service({ id: 'email-relay', match: undefined, plan: { tier: 'off', note: 'None today' } })), { evidence: [piece('lib', 'lib/geo.ts')] });
    expect(off).toEqual({ errors: [], warnings: [], unknown: [] });
  });

  it('only warns about an entry whose match no detector reads yet', () => {
    const f = file(service(), service({ id: 'pypi', match: { packages: ['pypi'] } }));
    const { errors, warnings } = validateCloud(f, { evidence: [piece('lib', 'lib/geo.ts')], kinds: ['lib', 'route', 'webhook'] });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/1 service\(s\) are matched only by evidence no detector reads yet .*packages.*: ext-pypi/)]);
  });

  it('warns, not fails, about an off service the code still reaches', () => {
    const f = file(service({ id: 'firebase', plan: { tier: 'off' }, match: { env: ['FIREBASE_*'] } }));
    const { errors, warnings } = validateCloud(f, { evidence: [piece('env', 'FIREBASE_KEY', { from: 'container-rag', file: 'stacks/x/docker-compose.yml' })] });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([expect.stringMatching(/ext-firebase is off, but the code still reaches it: stacks\/x\/docker-compose.yml/)]);
  });

  it('counts the plans that are unknown', () => {
    expect(validateCloud(file(service({ plan: { tier: 'unknown' } }))).unknown).toEqual(['geocoder']);
    expect(validateCloud(committed).unknown).toEqual([]);
  });

  it('refuses evidence of an unknown kind or about a node the map does not have', () => {
    expect(validateCloud(file(service()), { evidence: [piece('dns', 'x')] }).errors.join()).toMatch(/kind "dns"/);
    expect(validateCloud(file(service()), { evidence: [piece('lib', 'lib/geo.ts')], nodeIds: ['svc-other'] }).errors.join()).toMatch(/"svc-geo", which is not a node/);
  });
});

describe('deriveCloud', () => {
  const f = {
    ...file(service({ uses: [{ from: 'machine-a', label: 'by hand', why: 'Set in a UI' }], match: { libs: ['lib/geo.ts'], env: ['GEO_KEY'] } }), service({ id: 'relay', label: 'Email relay', roles: ['account'], match: undefined, plan: { tier: 'off', note: 'None today' } })),
    web: { label: 'Public web', desc: 'Any page', breaks: 'One page fails.', match: { libs: ['lib/safe-fetch.ts'] } }
  };
  const evidence = [piece('lib', 'lib/geo.ts'), piece('env', 'GEO_KEY', { from: 'container-api', label: 'its key', file: 'stacks/x/docker-compose.yml' }), piece('lib', 'lib/safe-fetch.ts', { from: 'svc-image', label: 'image-clone' })];
  const derived = deriveCloud({ ...memory(f), evidence, nodeIds: ['svc-geo', 'container-api', 'svc-image', 'machine-a'] });

  it('makes the store node under the root, one cloud node per entry and the public web, all under the store', () => {
    expect(derived.ownedIds).toEqual([CLOUD_STORE_ID]);
    expect(derived.nodes.map((n     ) => n.id)).toEqual(['store-cloud', 'ext-geocoder', 'ext-relay', 'ext-public-web']);
    expect(derived.nodes[0]).toEqual({ id: 'store-cloud', label: 'Cloud file', type: 'store', file: CLOUD_FILE });
    expect(derived.edges.filter((e     ) => !e.kind)).toEqual([
      { from: 'root', to: 'store-cloud' },
      { from: 'store-cloud', to: 'ext-geocoder' }, { from: 'store-cloud', to: 'ext-relay' }, { from: 'store-cloud', to: 'ext-public-web' }
    ]);
  });

  it('gives a cloud node the registry\'s fields and never its match, and the public web no roles or plan', () => {
    expect(derived.nodes[1]).toEqual({ id: 'ext-geocoder', label: 'Geocoder', type: 'external', kind: 'cloud', file: CLOUD_FILE, desc: 'Address search', roles: ['runtime'], breaks: 'Now: address search is empty.', plan: { tier: 'free' } });
    expect(derived.nodes[2].plan).toEqual({ tier: 'off', note: 'None today' });
    expect(derived.nodes[3]).toEqual({ id: 'ext-public-web', label: 'Public web', type: 'external', kind: 'web', file: CLOUD_FILE, desc: 'Any page', breaks: 'One page fails.' });
    for (const n of derived.nodes) expect(externalNodeProblems(n, { requireKind: true })).toEqual([]);
  });

  it('draws the matched evidence and the uses, and never writes an env var name', () => {
    expect(derived.edges.filter((e     ) => e.kind)).toEqual([
      { from: 'svc-geo', to: 'ext-geocoder', kind: 'calls', status: 'live', label: 'geo' },
      { from: 'container-api', to: 'ext-geocoder', kind: 'calls', status: 'live', label: 'its key' },
      { from: 'svc-image', to: 'ext-public-web', kind: 'calls', status: 'live', label: 'image-clone' },
      { from: 'machine-a', to: 'ext-geocoder', kind: 'calls', status: 'live', label: 'by hand' }
    ]);
    expect(JSON.stringify(derived)).not.toMatch(/GEO_KEY/);
  });

  it('throws on an invalid file, and on evidence with no file to describe it', () => {
    expect(() => deriveCloud({ ...memory(file(service({ plan: { tier: 'gold' } }))) })).toThrow(/topology.cloud.json is invalid:\n.*plan tier "gold"/);
    expect(() => deriveCloud({ read: () => '{', exists: () => true })).toThrow(/not valid JSON/);
    expect(() => deriveCloud({ read: () => '', exists: () => false, evidence })).toThrow(/there is no topology.cloud.json/);
    expect(deriveCloud({ read: () => '', exists: () => false }).nodes).toEqual([]);
  });

  it('knows every evidence kind the spec lists', () => {
    expect(Object.keys(EVIDENCE_KINDS).sort()).toEqual(['actions', 'caddy', 'env', 'host', 'image', 'lib', 'packages', 'registry', 'route', 'tailnet', 'webhook']);
  });
});

describe('cloudNodeProblems: the map against the file', () => {
  const f = { ...file(service()), web: { label: 'Public web', desc: 'Any page' } };
  it('accepts a map with a node per entry and the public web', () => {
    expect(cloudNodeProblems([{ id: 'ext-geocoder', type: 'external', kind: 'cloud' }, { id: 'ext-public-web', type: 'external', kind: 'web' }, { id: 'ext-nextcloud', type: 'external' }], f)).toEqual([]);
  });

  it('refuses a cloud node with no entry, an entry with no node, and a second web node', () => {
    const problems = cloudNodeProblems([{ id: 'ext-stray', type: 'external', kind: 'cloud' }, { id: 'ext-sites', type: 'external', kind: 'web' }], f);
    expect(problems).toEqual([
      expect.stringMatching(/Cloud node "ext-stray" has no entry in topology.cloud.json/),
      expect.stringMatching(/"ext-sites" is of kind web: the public web is one node/),
      expect.stringMatching(/describes ext-geocoder, which is not a cloud node on the map/)
    ]);
    expect(cloudNodeProblems([{ id: 'ext-public-web', type: 'external', kind: 'web' }], file(service({ id: 'x' })))[0]).toMatch(/has no "web"/);
  });
});

describe('the registry on a real map (the sample repo)', () => {
  let derived;
  const map = loadTopology();
  beforeAll(async () => {
    const config = await loadConfig(ROOT);
    derived = await deriveTopology({ root: ROOT, config, derivers: await loadDerivers(config), map });
  });
  const byId = () => new Map(derived.nodes.map((n) => [n.id, n]));
  const owned = (id) => derived.edges.some((e) => !e.kind && e.from === CLOUD_STORE_ID && e.to === id);

  it('draws every entry of the file under store-cloud, with its fields, and the store under the root', () => {
    expect(byId().get(CLOUD_STORE_ID)).toMatchObject({ type: 'store', file: CLOUD_FILE });
    expect(derived.edges.some((e) => !e.kind && e.from === 'root' && e.to === CLOUD_STORE_ID)).toBe(true);
    for (const s of committed.services) {
      const n = byId().get('ext-' + s.id);
      expect(n, s.id).toMatchObject({ type: 'external', kind: 'cloud', label: s.label, desc: s.desc, roles: s.roles, breaks: s.breaks, plan: s.plan });
      expect(n.match).toBeUndefined();
      expect(owned(n.id), n.id).toBe(true);
    }
    expect(byId().get('ext-public-web')).toMatchObject({ kind: 'web', label: committed.web.label });
    expect(derived.ownedIds).toContain(CLOUD_STORE_ID);
  });

  it('draws what the detectors found: images, the Dockerfile, CI, Caddy, hosts in code, and the uses', () => {
    const into = (id) => derived.edges.filter((e) => e.kind === 'calls' && e.to === id).map((e) => e.from).sort();
    expect(into('ext-docker-hub')).toEqual(['container-caddy', 'container-cloudflared', 'container-nextcloud', 'container-web', 'pkg-api']);
    expect(into('ext-ghcr')).toEqual(['container-homeassistant']);
    expect(into('ext-npm')).toEqual(['pkg-api', 'tool-ci']);
    expect(into('ext-github')).toEqual(['tool-ci']);
    expect(into('ext-cloudflare')).toEqual(['container-caddy', 'container-cloudflared', 'machine-server-1']);
    expect(into('ext-letsencrypt')).toEqual(['container-caddy']);
    expect(into('ext-nominatim')).toEqual(['page-api-geo']);
    expect(into('ext-google-fonts')).toEqual(['page-web-home']);
    expect(into('ext-registrar')).toEqual(['ext-cloudflare']);
    expect(derived.edges.find((e) => e.kind === 'calls' && e.to === 'ext-letsencrypt').when).toBe('renew');
    expect(derived.edges.find((e) => e.kind === 'calls' && e.to === 'ext-ghcr').when).toBe('deploy');
  });

  it('never writes an env var name the registry matches by into topology.json', () => {
    const text = JSON.stringify(map);
    const names = committed.services.flatMap((s) => (s.match && s.match.env) || []).map((n) => n.replace(/[*]$/, ''));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(text.includes(name), name).toBe(false);
  });

  it('matches the committed map: a node per entry and no stray cloud node', () => {
    expect(validateCloudNodes(map, ROOT)).toEqual([]);
    expect(validateCloudNodes({ nodes: [...map.nodes, { id: 'ext-stray', type: 'external', kind: 'cloud' }] }, ROOT)).toEqual([expect.stringMatching(/"ext-stray" has no entry/)]);
  });
});
