/**
 * @module explorer/cloud-model
 *
 * Cloud on the map, the explorer's pure half (spec 0031 sections 1 and 6, CLOUD-06): no DOM, no state.
 *
 *  - `WHEN_STYLES`, `whenOf`, `whenDash`: when an outage of a cloud service bites, read from a `calls` edge's
 *    `when` (absent = `run`), and how each looks: on the map (`dash`: solid, dashed, dotted), in the legend
 *    (`legend`), in the panel (`title`, `color`). The one place these live: scene.js, the legend, the panel and
 *    the House view's Cloud band (CLOUD-08) all read them here; the outage colours (CLOUD-07) are `color`.
 *  - `externalLayer(node)`: the Layers key of an `external` node, `cloud` or `web` (the public web, spec D3).
 *  - `planLabel`, `cloudUsedBy`: what the node panel shows of a cloud node, as data.
 *  - `cloudPanelHtml(node, nodes, edges)`: the node panel's facts for it, as HTML (panels.js puts them under the head).
 *
 * Nothing here reads an env var name, a token or a registry `match` list: a cloud node does not carry them, and
 * the panel shows only the node's own fields and the labels of the edges into it (the registry's words).
 */

import { escapeHtml as esc } from '../core/text.js';
import { capped } from './capped.js';

/**
 * When an outage bites, in order of how soon. `dash` is the scene edge's dash (world units, like a proposal
 * mark's), null for solid; `color` is the panel's and an outage scenario's for that group.
 */
export const WHEN_STYLES = {
  run: { title: 'Breaks now', legend: 'Solid: breaks as soon as it is down', dash: null, color: '#f87171' },
  deploy: { title: 'Breaks at the next deploy', legend: 'Dashed: breaks at the next deploy, rebuild or first run', dash: [9, 5], color: '#fbbf24' },
  renew: { title: 'Breaks at the next certificate renewal', legend: 'Dotted: breaks at the next certificate renewal', dash: [2, 4], color: '#a78bfa' },
};

/** A `calls` edge's `when`: `run` when absent (or not one of the three) */
export const whenOf = (edge) => (edge && Object.hasOwn(WHEN_STYLES, edge.when) ? edge.when : 'run');

/** The dash a `calls` edge is drawn with for its `when` (null = solid); any other kind of edge is not styled by it */
export const whenDash = (edge) => (edge && edge.kind === 'calls' ? WHEN_STYLES[whenOf(edge)].dash : null);

/** The Layers key of an outside node: the public web (kind `web`) is its own; every other external is Cloud */
export const externalLayer = (node) => (node && node.kind === 'web' ? 'web' : 'cloud');

const TIER_WORDS = { free: 'Free', paid: 'Paid', unknown: 'Plan unknown', off: 'Off' };

/** "Free", "Paid", "Plan unknown", "Off", with the plan's note after a dot; '' with no plan */
export function planLabel(plan) {
  if (!plan || !TIER_WORDS[plan.tier]) return '';
  return plan.note ? `${TIER_WORDS[plan.tier]} · ${plan.note}` : TIER_WORDS[plan.tier];
}

/** What a user of a cloud service is called, one and many (`nounOf(type, n)`: the outage scenario's words too) */
const NOUNS = {
  container: ['container', 'containers'], machine: ['machine', 'machines'], app: ['app', 'apps'],
  service: ['service', 'services'], page: ['endpoint', 'endpoints'], external: ['cloud service', 'cloud services'],
};
export const nounOf = (type, n) => { const w = NOUNS[type] || [type, `${type}s`]; return n === 1 ? w[0] : w[1]; };

/**
 * Who uses a cloud node, grouped by when its outage bites them: the `calls` edges into it, one group per `when`
 * that has any (`run`, `deploy`, `renew`, in that order), each split by what the users are (the biggest kind
 * first, then by type), each user once per group with its edge labels joined, sorted by name.
 * @returns {{ when:string, title:string, color:string, count:number,
 *   types: { type:string, noun:string, items: { id:string, label:string, type:string, via:string, browser:boolean }[] }[] }[]}
 */
export function cloudUsedBy(node, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = new Map(Object.keys(WHEN_STYLES).map((w) => [w, new Map()]));
  for (const e of edges) {
    if (e.kind !== 'calls' || e.to !== node.id) continue;
    const users = groups.get(whenOf(e));
    const from = byId.get(e.from) || { id: e.from, label: e.from, type: 'node' };
    const item = users.get(e.from) || { id: e.from, label: String(from.label || e.from), type: from.type, vias: [], browser: false };
    if (e.label && !item.vias.includes(e.label)) item.vias.push(e.label);
    if (e.side === 'browser') item.browser = true;
    users.set(e.from, item);
  }
  const out = [];
  for (const [when, users] of groups) {
    if (users.size === 0) continue;
    const byType = new Map();
    for (const { vias, ...item } of users.values()) {
      if (!byType.has(item.type)) byType.set(item.type, []);
      byType.get(item.type).push({ ...item, via: vias.join(', ') });
    }
    const types = [...byType].map(([type, items]) => ({ type, noun: nounOf(type, 1), items: items.sort((a, b) => a.label.localeCompare(b.label)) }))
      .sort((a, b) => b.items.length - a.items.length || a.type.localeCompare(b.type));
    const { title, color } = WHEN_STYLES[when];
    out.push({ when, title, color, count: users.size, types });
  }
  return out;
}

/** The fact names for the groups of users, short enough for the panel's key column (the long words are WHEN_STYLES `title`) */
const WHEN_KEYS = { run: 'Breaks now', deploy: 'Breaks on deploy', renew: 'Breaks on renewal' };

const fact = (key, rows) => (rows.length ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">${esc(key)}</div><div class="hx-fact-v">${capped(rows)}</div></div>` : '');
const line = (body) => `<div class="hx-line">${body}</div>`;
const name = (label) => `<span class="hx-name">${esc(label)}</span>`;

/** One user of the node: its name, (browser) when the visitor's browser makes the call, the edge's labels, and what it is when the group mixes kinds */
function userRow(item, mixed) {
  const browser = item.browser ? ' <span class="hx-cloud-browser">(browser)</span>' : '';
  const bits = [mixed ? nounOf(item.type, 1) : '', item.via].filter(Boolean);
  return line(`<span>${name(item.label)}${browser}${bits.length ? `<span class="hx-faint"> · ${esc(bits.join(' · '))}</span>` : ''}</span>`);
}

/** The Play button (spec 0031 section 8, CLOUD-07): main.js plays outage-model.js `outageScenario` for the node. A quiet button under the facts. */
const playButton = (node) => `<button type="button" class="hx-btn hx-btn--quiet hx-cloud-play" data-action="play-outage" data-id="${esc(node.id)}">Play: ${esc(String(node.label || node.id))} is down</button>`;

/**
 * The node panel's facts for a cloud node (kind `cloud`) or the public web (kind `web`), in the node panel's key/value
 * rows (the type and the name are the panel's head): Plan, Roles, If it's down, who uses it by when its outage bites
 * (one fact per `when` that has any, long lists folded by capped.js), what it relies on itself (calls to other cloud
 * nodes), the webhooks it sends, then a quiet Play button (a cloud node only). The caller adds the File line.
 */
export function cloudPanelHtml(node, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const label = (id) => String((byId.get(id) || { label: id }).label || id);
  const web = node.kind === 'web'; // the public web: no plan, no roles, no Play
  const roles = web ? [] : node.roles || [];
  const used = cloudUsedBy(node, nodes, edges).map((g) => {
    const mixed = g.types.length > 1;
    return fact(WHEN_KEYS[g.when], g.types.flatMap((t) => t.items.map((i) => userRow(i, mixed))));
  }).join('') || fact('Used by', [line('<span class="hx-faint">Nothing on the map uses it.</span>')]);

  const relies = edges.filter((e) => e.kind === 'calls' && e.from === node.id && (byId.get(e.to) || {}).type === 'external')
    .map((e) => line(`<span>${name(label(e.to))}${e.label ? `<span class="hx-faint"> · ${esc(e.label)}</span>` : ''}</span>`));
  const pushes = edges.filter((e) => e.kind === 'delivers' && e.from === node.id).map((e) => line(name(label(e.to))));

  return (web ? '' : fact('Plan', [line(esc(planLabel(node.plan) || TIER_WORDS.unknown))]))
    + fact('Roles', roles.length ? [line(esc(roles.join(', ')))] : [])
    + fact('If it\'s down', [line(esc(node.breaks || 'Not described yet.'))])
    + used
    + fact('Relies on', relies)
    + fact('Pushes to', pushes)
    + (web ? '' : playButton(node)); // the public web is never down as a whole (spec D3)
}
