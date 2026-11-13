/**
 * @module core/personas
 *
 * Personas on the map (spec 0029 section 2, PHY-02): archetypes a scenario can act as, kept in a
 * committed file (`topology.personas.json`) and validated like a proposal. A persona is never a real
 * person: it is a role and the groups that role sits in, or "no account". Pure, no I/O except through
 * the readers a caller passes, so the topology tool and the explorer use the same code.
 *
 *   {
 *     "version": 1,
 *     "personas": [
 *       { "id": "adult", "label": "Adult", "role": "adult", "groups": ["family"], "desc": "A grown-up of the household" },
 *       { "id": "guest", "label": "Guest (no account)", "account": false, "desc": "Someone with no account" }
 *     ]
 *   }
 *
 *  - `role` is one of the roles the config declares (`personas.roles` in cornfield.config.js); with no
 *    list, any role in kebab case is accepted. The tool does not know any role by name.
 *  - `groups` lists group ids. Left out, it means any groups; `[]` means none of the deciding groups.
 *    The **deciding groups** are every group any persona names.
 *  - `account: false` is a persona with no session at all: it has neither a role nor groups.
 *
 * What this module does:
 *  - `validatePersonas(file, { roles })`: one line per problem (id, text, role, groups, and that no two
 *    personas would count the same account).
 *  - `matchPersona` / `countAccounts`: the counting the live layer applies to the API's role-and-group
 *    totals. An account belongs to the persona with its role and its membership of the deciding groups
 *    (or the one persona of that role that leaves `groups` out); the rest are "Other accounts".
 *  - `derivePersonas`: the nodes and edges `sync` writes (`store-personas`, one `persona-<id>` each),
 *    in the shape a deriver returns (plugins/personas is the deriver).
 */
import { personaNodeId } from './schema.js';

export const PERSONAS_FILE = 'topology.personas.json';
export const PERSONA_STORE_ID = 'store-personas';
/** The node the personas store hangs under unless the config names another (`personas.parent`) */
export const DEFAULT_PARENT = 'root';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const KEYS = ['id', 'label', 'desc', 'role', 'groups', 'account'];
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether a persona stands for an account (anything but `account: false`) */
export const hasAccount = (persona) => persona.account !== false;

/**
 * Every group any persona names, sorted.
 * @param {{ groups?: string[] }[]} personas
 * @returns {string[]}
 */
export function decidingGroups(personas) {
  const set = new Set();
  for (const p of personas) if (hasAccount(p) && Array.isArray(p.groups)) for (const g of p.groups) set.add(g);
  return [...set].sort();
}

/**
 * What decides which accounts a persona counts: its role and its groups among the deciding ones.
 * `groups: null` is "any groups" (the persona left `groups` out).
 * @returns {{ role: string, groups: string[] | null } | null} null for a persona with no account
 */
export function personaSignature(persona) {
  if (!hasAccount(persona)) return null;
  return { role: persona.role, groups: Array.isArray(persona.groups) ? [...new Set(persona.groups)].sort() : null };
}

/**
 * What is wrong with a personas file.
 * @param {any} file the parsed `topology.personas.json`
 * @param {{ roles?: string[] | null }} [opts] the roles the config declares; none = any kebab-case role
 * @returns {string[]} one line per problem, each starting with where it is
 */
export function validatePersonas(file, { roles = null } = {}) {
  /** @type {string[]} */
  const problems = [];
  const err = (where, message) => problems.push(`${where}: ${message}`);
  if (!isObject(file)) return [`must be an object like { "version": 1, "personas": [...] }.`];
  if (file.version !== 1) err('version', `must be 1 (got ${JSON.stringify(file.version)}).`);
  for (const key of Object.keys(file)) if (!['version', 'personas'].includes(key)) err(key, `unknown key "${key}": the file has version and personas.`);
  if (!Array.isArray(file.personas) || file.personas.length === 0) {
    err('personas', 'must be a list of at least one persona.');
    return problems;
  }

  const seen = new Set();
  /** @type {{ id: string, role?: string, groups?: string[], account?: boolean }[]} */
  const good = [];
  file.personas.forEach((p, i) => {
    const at = `personas[${i}]`;
    if (!isObject(p)) return err(at, 'a persona is an object with id, label, desc and a role (or account: false).');
    const name = isText(p.id) ? `${at} "${p.id}"` : at;
    let ok = true;
    const bad = (message) => { ok = false; err(name, message); };

    for (const key of Object.keys(p)) if (p[key] !== undefined && !KEYS.includes(key)) bad(`unknown key "${key}". A persona has: ${KEYS.join(', ')}.`);
    if (!isText(p.id) || !KEBAB.test(p.id)) bad(`"id" must be lower-case words joined by dashes, like "outside-friend" (got ${JSON.stringify(p.id)}).`);
    else if (seen.has(p.id)) bad(`duplicate id "${p.id}".`);
    else seen.add(p.id);
    if (!isText(p.label)) bad('needs a "label": the name the node shows.');
    if (!isText(p.desc)) bad('needs a "desc": a sentence saying who this persona is. Never a real person.');

    if (p.account !== undefined && p.account !== false) bad('"account" can only be false (a persona with no account); leave it out otherwise.');
    if (p.account === false) {
      if (p.role !== undefined) bad('"account": false has no role: someone with no account has none.');
      if (p.groups !== undefined) bad('"account": false has no groups: someone with no account is in none.');
    } else {
      if (!isText(p.role)) bad(`needs a "role"${roles ? ` (one of ${roles.join(', ')})` : ''}, or "account": false.`);
      else if (roles && !roles.includes(p.role)) bad(`unknown role "${p.role}". The config declares: ${roles.join(', ')}.`);
      else if (!roles && !KEBAB.test(p.role)) bad(`"role" must be lower-case words joined by dashes (got ${JSON.stringify(p.role)}).`);
      if (p.groups !== undefined) {
        if (!Array.isArray(p.groups) || p.groups.some((g) => !isText(g) || !KEBAB.test(g))) bad('"groups" must be a list of group ids (lower-case words joined by dashes).');
        else if (new Set(p.groups).size !== p.groups.length) bad('"groups" names the same group twice.');
      }
    }
    if (ok) good.push(p);
  });

  // No two personas may count the same account
  for (let i = 0; i < good.length; i++) {
    for (let j = i + 1; j < good.length; j++) {
      const a = personaSignature(good[i]);
      const b = personaSignature(good[j]);
      if (!a || !b || a.role !== b.role) continue;
      const sameGroups = a.groups && b.groups && a.groups.join(',') === b.groups.join(',');
      if (sameGroups) err(`personas "${good[i].id}" and "${good[j].id}"`, `would count the same accounts: both are role ${a.role} with groups [${a.groups?.join(', ')}]. Change one's groups, or merge them.`);
      else if (!a.groups || !b.groups) err(`personas "${good[i].id}" and "${good[j].id}"`, `would count the same accounts: both are role ${a.role} and one leaves "groups" out (any groups), which includes the other's. Give both a "groups" list.`);
    }
  }
  return problems;
}

/**
 * The persona an account counts toward, or null (it is one of the "Other accounts").
 * @param {{ id: string, role?: string, groups?: string[], account?: boolean }[]} personas a valid list
 * @param {{ role: string, groups?: string[] }} account the account's role and the groups it is in
 * @returns {{ id: string } | null}
 */
export function matchPersona(personas, account) {
  const deciding = decidingGroups(personas);
  const mine = deciding.filter((g) => (account.groups || []).includes(g)).sort().join(',');
  const sameRole = personas.filter((p) => hasAccount(p) && p.role === account.role);
  return sameRole.find((p) => Array.isArray(p.groups) && [...new Set(p.groups)].sort().join(',') === mine)
    || sameRole.find((p) => !Array.isArray(p.groups))
    || null;
}

/**
 * Counts accounts per persona. An account with no persona goes to `other`.
 * @param {{ id: string, role?: string, groups?: string[], account?: boolean }[]} personas
 * @param {{ role: string, groups?: string[], count?: number }[]} accounts one entry per kind of account, with a count
 * @returns {{ counts: Record<string, number>, other: number }} every persona is a key (a persona with no account stays 0)
 */
export function countAccounts(personas, accounts) {
  const counts = Object.fromEntries(personas.map((p) => [p.id, 0]));
  let other = 0;
  for (const a of accounts) {
    const n = a.count ?? 1;
    const p = matchPersona(personas, a);
    if (p) counts[p.id] += n;
    else other += n;
  }
  return { counts, other };
}

/** "role adult, in the family group": who a persona stands for, in words */
function who(persona, deciding) {
  if (!hasAccount(persona)) return 'no account';
  if (!Array.isArray(persona.groups)) return `role ${persona.role}, any groups`;
  if (persona.groups.length === 0) return `role ${persona.role}, in none of the ${deciding.join(', ')} group${deciding.length === 1 ? '' : 's'}`;
  return `role ${persona.role}, in the ${persona.groups.join(', ')} group${persona.groups.length === 1 ? '' : 's'}`;
}

/**
 * The persona nodes and the file's store node, for `sync`.
 * @param {object} io
 * @param {(rel: string) => string} io.read
 * @param {(rel: string) => boolean} io.exists
 * @param {string[]|null} [io.roles] the roles the config declares (`personas.roles`); none = any kebab-case role
 * @param {string} [io.parent] the node the personas store hangs under (default `root`)
 * @returns {{ nodes: any[], edges: any[], warnings: string[], ownedIds: string[] }}
 */
export function derivePersonas({ read, exists, roles = null, parent = DEFAULT_PARENT }) {
  const none = { nodes: [], edges: [], warnings: [], ownedIds: [] };
  if (!exists(PERSONAS_FILE)) return none;
  let file;
  try {
    file = JSON.parse(read(PERSONAS_FILE));
  } catch (err) {
    throw new Error(`personas: ${PERSONAS_FILE} is not valid JSON: ${err.message}`);
  }
  const problems = validatePersonas(file, { roles });
  if (problems.length) throw new Error(`personas: ${PERSONAS_FILE} is invalid:\n  ${problems.join('\n  ')}`);

  const deciding = decidingGroups(file.personas);
  const nodes = [{ id: PERSONA_STORE_ID, label: 'Personas file', type: 'store', file: PERSONAS_FILE }];
  const edges = [{ from: parent, to: PERSONA_STORE_ID }];
  for (const p of file.personas) {
    const id = personaNodeId(p.id);
    const desc = p.desc.trim();
    nodes.push({
      id,
      label: p.label,
      type: 'persona',
      file: PERSONAS_FILE,
      desc: `Persona ${p.label}: ${who(p, deciding)}. ${/[.!?]$/.test(desc) ? desc : `${desc}.`}`,
      role: hasAccount(p) ? p.role : undefined,
      groups: hasAccount(p) && Array.isArray(p.groups) ? p.groups : undefined,
      account: hasAccount(p) ? undefined : false
    });
    edges.push({ from: PERSONA_STORE_ID, to: id });
  }
  return { nodes, edges, warnings: [], ownedIds: [PERSONA_STORE_ID] };
}
