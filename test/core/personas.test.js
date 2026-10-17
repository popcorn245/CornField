import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePersonas, decidingGroups, matchPersona, countAccounts, derivePersonas, PERSONAS_FILE, PERSONA_STORE_ID } from '../../core/personas.js';
import { personaNodeId } from '../../core/schema.js';
import { validatePersonasFile, validateProposalFiles, validateRepo } from '../../core/validate.js';
import { loadConfig, loadDerivers } from '../../core/config.js';
import { SAMPLE as ROOT, loadSample as loadTopology } from '../helpers.js';
const real = {
  read: (rel        ) => fs.readFileSync(path.join(ROOT, rel), 'utf8'),
  exists: (rel        ) => fs.existsSync(path.join(ROOT, rel)),
};
const ROLES = ['admin', 'adult', 'child'];
const committed = JSON.parse(real.read(PERSONAS_FILE));

const persona = (extra                          = {}) => ({ id: 'adult', label: 'Adult', role: 'adult', groups: ['family'], desc: 'A grown-up', ...extra });
const file = (...personas           ) => ({ version: 1, personas });
const problems = (f         ) => validatePersonas(f, { roles: ROLES });

describe('validatePersonas', () => {
  it('accepts the committed file', () => {
    expect(problems(committed)).toEqual([]);
  });

  it('wants version 1 and a list of personas', () => {
    expect(problems(null)[0]).toMatch(/must be an object/);
    expect(problems({ version: 2, personas: [persona()] })).toEqual([expect.stringMatching(/^version: must be 1/)]);
    expect(problems({ version: 1 })).toEqual([expect.stringMatching(/^personas: must be a list/)]);
    expect(problems({ version: 1, personas: [] })).toHaveLength(1);
    expect(problems({ ...file(persona()), extra: true })[0]).toMatch(/unknown key "extra"/);
  });

  it('wants a kebab-case id, unique across the file', () => {
    expect(problems(file(persona({ id: 'Adult' })))[0]).toMatch(/"id" must be lower-case words/);
    expect(problems(file(persona({ id: undefined })))[0]).toMatch(/"id" must be lower-case words/);
    const dup = problems(file(persona(), persona({ role: 'child', groups: ['family'] })));
    expect(dup).toEqual([expect.stringMatching(/duplicate id "adult"/)]);
  });

  it('wants a label and a desc', () => {
    expect(problems(file(persona({ label: '' })))[0]).toMatch(/needs a "label"/);
    expect(problems(file(persona({ desc: undefined })))[0]).toMatch(/needs a "desc"/);
  });

  it('refuses a role the plugin does not declare', () => {
    const [msg] = problems(file(persona({ role: 'owner' })));
    expect(msg).toMatch(/unknown role "owner"/);
    expect(msg).toMatch(/admin, adult, child/);
    expect(problems(file(persona({ role: undefined })))[0]).toMatch(/needs a "role"/);
  });

  it('checks the groups list', () => {
    expect(problems(file(persona({ groups: 'family' })))[0]).toMatch(/"groups" must be a list/);
    expect(problems(file(persona({ groups: ['Family'] })))[0]).toMatch(/"groups" must be a list/);
    expect(problems(file(persona({ groups: ['family', 'family'] })))[0]).toMatch(/same group twice/);
  });

  it('refuses unknown keys on a persona', () => {
    expect(problems(file(persona({ name: 'x' })))[0]).toMatch(/unknown key "name"/);
  });

  it('wants account: false to have neither a role nor groups', () => {
    const guest = { id: 'guest', label: 'Guest', desc: 'Nobody in particular', account: false };
    expect(problems(file(guest))).toEqual([]);
    expect(problems(file({ ...guest, role: 'child' }))[0]).toMatch(/has no role/);
    expect(problems(file({ ...guest, groups: [] }))[0]).toMatch(/has no groups/);
    expect(problems(file({ ...guest, account: true }))[0]).toMatch(/can only be false/);
  });

  it('refuses two personas that would count the same account', () => {
    const twin = problems(file(persona(), persona({ id: 'grown-up', label: 'Grown-up' })));
    expect(twin).toEqual([expect.stringMatching(/"adult" and "grown-up": would count the same accounts/)]);
    // same groups in another order
    const a = persona({ id: 'a', groups: ['family', 'club'] });
    const b = persona({ id: 'b', groups: ['club', 'family'] });
    expect(problems(file(a, b))).toHaveLength(1);
    // one leaves groups out (any groups), which includes the other's
    const any = persona({ id: 'any-adult', groups: undefined });
    expect(problems(file(persona(), any))[0]).toMatch(/leaves "groups" out/);
    expect(problems(file(any, persona({ id: 'outside', groups: [] })))[0]).toMatch(/leaves "groups" out/);
  });

  it('allows the same role with different groups, and the same groups with different roles', () => {
    expect(problems(file(persona(), persona({ id: 'outside', groups: [] })))).toEqual([]);
    expect(problems(file(persona(), persona({ id: 'child', role: 'child' })))).toEqual([]);
        const nobody = (id        ) => ({ id, label: id, desc: 'Nobody', account: false });
    expect(problems(file(nobody('g1'), nobody('g2')))).toEqual([]);
  });
});

describe('the committed personas file', () => {
  it('has the five personas of spec 0029', () => {
    expect(committed.personas.map((p     ) => p.id)).toEqual(['admin', 'adult', 'child', 'contributor', 'guest']);
    const by = Object.fromEntries(committed.personas.map((p     ) => [p.id, p]));
    expect(by.admin).toMatchObject({ label: 'Admin', role: 'admin' });
    expect(by.admin.groups).toBeUndefined();
    expect(by.adult).toMatchObject({ role: 'adult', groups: ['family'] });
    expect(by.child).toMatchObject({ role: 'child', groups: ['family'] });
    expect(by.contributor).toMatchObject({ label: 'Outside contributor', role: 'adult', groups: [] });
    expect(by.guest).toMatchObject({ label: 'Guest (no account)', account: false });
    expect(by.guest.role).toBeUndefined();
  });

  it('takes its roles from the config, which declares admin, adult and child', () => {
    expect(validatePersonasFile(ROOT, ROLES)).toEqual([]);
    expect(validatePersonasFile(ROOT, ['admin'])).toEqual([expect.stringMatching(/unknown role "adult". The config declares: admin/), expect.stringMatching(/unknown role "child"/), expect.stringMatching(/unknown role "adult"/)]);
  });
});

describe('counting accounts', () => {
  const personas = committed.personas;
  it('finds the deciding groups', () => {
    expect(decidingGroups(personas)).toEqual(['family']);
  });

  it('matches an account by role and by its membership of the deciding groups', () => {
    const idOf = (account     ) => matchPersona(personas, account)?.id ?? null;
    expect(idOf({ role: 'admin', groups: [] })).toBe('admin');
    expect(idOf({ role: 'admin', groups: ['family'] })).toBe('admin');
    expect(idOf({ role: 'adult', groups: ['family'] })).toBe('adult');
    expect(idOf({ role: 'child', groups: ['family'] })).toBe('child');
    expect(idOf({ role: 'adult', groups: [] })).toBe('contributor');
    // a group no persona names does not decide anything
    expect(idOf({ role: 'adult', groups: ['gamers'] })).toBe('contributor');
    expect(idOf({ role: 'adult', groups: ['gamers', 'family'] })).toBe('adult');
    // a child outside the family is nobody's persona: an old site account
    expect(idOf({ role: 'child', groups: [] })).toBeNull();
    expect(idOf({ role: 'child' })).toBeNull();
  });

  it('never counts an account toward a persona with no account', () => {
    expect(matchPersona([{ id: 'guest', account: false }], { role: 'adult' })).toBeNull();
  });

  it('sums the counts, with every persona a key and the rest in other', () => {
    const { counts, other } = countAccounts(personas, [
      { role: 'admin', groups: ['family'], count: 1 },
      { role: 'adult', groups: ['family'], count: 2 },
      { role: 'child', groups: ['family'], count: 2 },
      { role: 'adult', groups: [], count: 1 },
      { role: 'child', groups: [], count: 3 },
    ]);
    expect(counts).toEqual({ admin: 1, adult: 2, child: 2, contributor: 1, guest: 0 });
    expect(other).toBe(3);
  });

  it('counts one for an entry with no count', () => {
    expect(countAccounts(personas, [{ role: 'admin' }, { role: 'admin' }]).counts.admin).toBe(2);
  });

  it('lets a lone persona that leaves groups out count every account of its role', () => {
    const lone = [{ id: 'any', role: 'adult', label: 'Any', desc: 'x' }];
    expect(countAccounts(lone, [{ role: 'adult', groups: ['x'], count: 2 }, { role: 'adult', count: 1 }, { role: 'child', count: 1 }])).toEqual({ counts: { any: 3 }, other: 1 });
  });
});

describe('derivePersonas', () => {
  const derived = derivePersonas({ ...real, roles: ROLES });

  it('makes the personas file a store under the root and one persona node under it for each entry', () => {
    expect(derived.nodes[0]).toEqual({ id: PERSONA_STORE_ID, label: 'Personas file', type: 'store', file: 'topology.personas.json' });
    expect(derived.nodes.slice(1).map((n     ) => n.id)).toEqual(['persona-admin', 'persona-adult', 'persona-child', 'persona-contributor', 'persona-guest']);
    expect(derived.edges[0]).toEqual({ from: 'root', to: PERSONA_STORE_ID });
    expect(derivePersonas({ ...real, roles: ROLES, parent: 'tool-x' }).edges[0]).toEqual({ from: 'tool-x', to: PERSONA_STORE_ID });
    for (const n of derived.nodes.slice(1)) expect(derived.edges).toContainEqual({ from: PERSONA_STORE_ID, to: n.id });
    expect(derived.ownedIds).toEqual([PERSONA_STORE_ID]);
  });

  it('derives the id the scenario actor names', () => {
    for (const p of committed.personas) expect(derived.nodes.some((n     ) => n.id === personaNodeId(p.id))).toBe(true);
  });

  it('carries label, role, groups and account, and says in words who the persona is', () => {
    const node = (id        ) => derived.nodes.find((n     ) => n.id === `persona-${id}`);
    expect(node('adult')).toMatchObject({ type: 'persona', label: 'Adult', role: 'adult', groups: ['family'], file: 'topology.personas.json' });
    expect(node('adult').desc).toBe('Persona Adult: role adult, in the family group. A parent or another grown-up of the household.');
    expect(node('admin').desc).toMatch(/^Persona Admin: role admin, any groups\. /);
    expect(node('admin').groups).toBeUndefined();
    expect(node('contributor')).toMatchObject({ role: 'adult', groups: [] });
    expect(node('contributor').desc).toMatch(/in none of the family group\./);
    expect(node('guest')).toMatchObject({ account: false });
    expect(node('guest').role).toBeUndefined();
    expect(node('guest').desc).toMatch(/^Persona Guest \(no account\): no account\./);
  });

  it('derives nothing when there is no file, and refuses an invalid one', () => {
    expect(derivePersonas({ read: real.read, exists: () => false })).toEqual({ nodes: [], edges: [], warnings: [], ownedIds: [] });
    const bad = (text        ) => () => derivePersonas({ read: (rel        ) => (rel === PERSONAS_FILE ? text : real.read(rel)), exists: () => true, roles: ROLES });
    expect(bad('{')).toThrow(/not valid JSON/);
    expect(bad('{"version":1,"personas":[{"id":"x","label":"X","role":"owner","desc":"d"}]}')).toThrow(/unknown role "owner"/);
  });
});

describe('the map', () => {
  const topology = loadTopology();

  it('holds the five persona nodes under the personas store, which hangs under the root', () => {
    const personas = topology.nodes.filter((n     ) => n.type === 'persona');
    expect(personas.map((n     ) => n.id).sort()).toEqual(['persona-admin', 'persona-adult', 'persona-child', 'persona-contributor', 'persona-guest']);
    expect(topology.edges).toContainEqual({ from: 'root', to: PERSONA_STORE_ID });
    for (const n of personas) expect(topology.edges).toContainEqual({ from: PERSONA_STORE_ID, to: n.id });
  });

  it('passes validate, with no drift', async () => {
    const config = await loadConfig(ROOT);
    expect((await validateRepo({ config, derivers: await loadDerivers(config) })).errors).toEqual([]);
  });
});

describe('validate checks the file and the scenario actors', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'personas-'));

  it('names the file and the problem for a broken personas file', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, PERSONAS_FILE), JSON.stringify(file(persona({ role: 'owner' }))));
    expect(validatePersonasFile(root, ROLES)).toEqual([expect.stringMatching(/^topology\.personas\.json: personas\[0\] "adult": unknown role "owner"/)]);
    fs.writeFileSync(path.join(root, PERSONAS_FILE), '{nope');
    expect(validatePersonasFile(root, ROLES)).toEqual([expect.stringMatching(/is not valid JSON/)]);
    expect(validatePersonasFile(tmp(), ROLES)).toEqual([]);
  });

  it('accepts any kebab-case role when the config names none, and nothing else', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, PERSONAS_FILE), JSON.stringify(file(persona({ role: 'owner' }))));
    expect(validatePersonasFile(root)).toEqual([]);
    fs.writeFileSync(path.join(root, PERSONAS_FILE), JSON.stringify(file(persona({ role: 'Big Boss' }))));
    expect(validatePersonasFile(root)).toEqual([expect.stringMatching(/"role" must be lower-case words/)]);
  });

  it('fails a committed proposal whose scenario names a persona the map does not have', () => {
    const dir = tmp();
    const proposal = (actor        ) => ({
      version: 1, title: 'T', summary: 'S',
      nodes: { add: [{ id: 'page-new', label: '/new', type: 'page', parent: 'root', desc: 'x' }] },
      scenarios: [{ id: 's', title: 'S', actor, steps: [{ node: 'page-new', text: 'Opens it' }] }],
    });
    const topology = loadTopology();
    fs.writeFileSync(path.join(dir, '9999-ok.json'), JSON.stringify(proposal('child')));
    expect(validateProposalFiles(topology, dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, '9999-ok.json'), JSON.stringify(proposal('stranger')));
    const out = validateProposalFiles(topology, dir);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/9999-ok\.json: scenarios\[0\]\.actor: Actor "stranger" is no persona: "persona-stranger"/);
  });

  it('resolves the actors of every committed proposal against real persona nodes', () => {
    const topology = loadTopology();
    const ids = new Set(topology.nodes.map((n     ) => n.id));
    const dir = path.join(ROOT, 'docs/specs/proposals');
    let seen = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.endsWith('.review.json'))) {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const s of p.scenarios || []) {
        for (const actor of [s.actor, ...s.steps.map((st     ) => st.actor)].filter(Boolean)) {
          seen++;
          expect(ids.has(personaNodeId(actor)), `${f}: actor ${actor}`).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
