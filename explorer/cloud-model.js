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
 *  - `cloudBadges`, `planLabel`, `cloudUsedBy`: what the node panel shows of a cloud node, as data.
 *  - `cloudPanelHtml(node, nodes, edges)`: that panel section as HTML (panels.js puts it in the drawer).
 *
 * Nothing here reads an env var name, a token or a registry `match` list: a cloud node does not carry them, and
 * the panel shows only the node's own fields and the labels of the edges into it (the registry's words).
 */

import { escapeHtml as esc } from '../core/text.js';

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

/** The kind and the roles, as the panel's badges: ['Cloud', 'runtime', 'account'], or ['Public web', 'not cloud'] */
export function cloudBadges(node) {
  if (node.kind === 'web') return ['Public web', 'not cloud'];
  return ['Cloud', ...(node.roles || [])];
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

/** More users of one kind than this, in one group, fold into a count ("42 containers") with the list behind it */
export const FOLD_AT = 8;

const sec = (title, body) => `<div class="hx-sec"><strong class="hx-strong">${title}</strong>${body}</div>`;
const row = (color, arrow, body) => `<div class="hx-line"><span class="hx-glyph" style="--glyph:${color}">${arrow}</span><span>${body}</span></div>`;
const name = (label) => `<span class="hx-name">${esc(label)}</span>`;

function userRow(item, color) {
  const browser = item.browser ? ' <span class="hx-cloud-browser">(browser)</span>' : '';
  return row(color, '←', `${name(item.label)}${browser}${item.via ? `<span class="hx-faint"> · ${esc(item.via)}</span>` : ''}`);
}

function groupHtml(group) {
  const lists = group.types.map((t) => {
    const rows = t.items.map((i) => userRow(i, group.color)).join('');
    if (t.items.length <= FOLD_AT) return rows;
    return `<details class="hx-cloud-fold"><summary>${t.items.length} ${esc(nounOf(t.type, t.items.length))}</summary>${rows}</details>`;
  }).join('');
  return `<div class="hx-cloud-when hx-cloud-when--${group.when}">`
    + `<div class="hx-cloud-when-head"><span class="hx-swatch-line hx-swatch-when hx-swatch-when--${group.when}"></span>`
    + `<span class="hx-glyph" style="--glyph:${group.color}">${esc(group.title)}</span><span class="hx-count">${group.count}</span></div>${lists}</div>`;
}

/** The Play button (spec 0031 section 8, CLOUD-07): main.js plays outage-model.js `outageScenario` for the node */
const playButton = (node) => `<div class="hx-sec"><button type="button" class="hx-btn hx-cloud-play" data-action="play-outage" data-id="${esc(node.id)}">▶ Play: ${esc(String(node.label || node.id))} is down</button></div>`;

/**
 * The node panel's section for a cloud node (kind `cloud`) or the public web (kind `web`): badges and plan,
 * "If it's down", Used by grouped by when, the Play button (a cloud node only), what it relies on itself (calls to other cloud nodes) and the
 * webhooks it sends. The caller adds the doc link.
 */
export function cloudPanelHtml(node, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const label = (id) => String((byId.get(id) || { label: id }).label || id);
  const [kind, ...roles] = cloudBadges(node);
  const tier = node.kind === 'web' ? null : (node.plan && TIER_WORDS[node.plan.tier] ? node.plan.tier : 'unknown');
  const badges = `<div class="hx-cloud-badges"><span class="hx-cloud-badge hx-cloud-badge--${node.kind === 'web' ? 'web' : 'kind'}">${esc(kind)}</span>`
    + roles.map((r) => `<span class="hx-cloud-badge">${esc(r)}</span>`).join('')
    + (tier ? `<span class="hx-cloud-plan hx-cloud-plan--${tier}">${esc(TIER_WORDS[tier])}</span>` : '')
    + '</div>'
    + (tier && node.plan && node.plan.note ? `<div class="hx-faint hx-cloud-plan-note">${esc(node.plan.note)}</div>` : '');

  const groups = cloudUsedBy(node, nodes, edges);
  const usedBy = groups.length ? groups.map(groupHtml).join('') : '<div class="hx-faint">Nothing on the map uses it.</div>';

  const relies = edges.filter((e) => e.kind === 'calls' && e.from === node.id && (byId.get(e.to) || {}).type === 'external')
    .map((e) => row(WHEN_STYLES[whenOf(e)].color, '→', `${name(label(e.to))}${e.label ? `<span class="hx-faint"> · ${esc(e.label)}</span>` : ''}`));
  const pushes = edges.filter((e) => e.kind === 'delivers' && e.from === node.id).map((e) => row('#94a3b8', '→', name(label(e.to))));

  return `<div class="hx-cloud">${badges}`
    + sec('If it\'s down:', `<div class="hx-cloud-breaks">${esc(node.breaks || 'Not described yet.')}</div>`)
    + sec('Used by:', usedBy)
    + (node.kind === 'web' ? '' : playButton(node)) // the public web is never down as a whole (spec D3)
    + (relies.length ? sec('Relies on:', relies.join('')) : '')
    + (pushes.length ? sec('Pushes to (webhook):', pushes.join('')) : '')
    + '</div>';
}
