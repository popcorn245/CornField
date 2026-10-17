/**
 * @module explorer/outage-model
 *
 * "X is down" (spec 0031 section 8, CLOUD-07), the explorer's pure half: no DOM, no state.
 *
 *  - `blastRadius(down, nodes, edges)`: what an outage of the down cloud nodes breaks, and when. From each down
 *    node, back along the `calls` edges into it to their users; each user is hit with the edge's `when` (absent =
 *    `run`). What is hit passes it on: whatever calls a hit node is hit too (a cloud node that uses a down one is
 *    down too, transitively; a service that calls a hit service), a hit container hits the apps it serves (the
 *    `runs-on` mappings that name its service in its stack), a hit service the endpoints that start it (`triggers`
 *    from a page). A chain bites no sooner than its latest link (Caddy renews through Cloudflare, so the registrar
 *    being down breaks Caddy at the next renewal, not now); of several paths the strongest wins, in `WHEN_STYLES`
 *    order: run, then deploy, then renew. A hit only through a `side: browser` call is the visitor's browser, and
 *    says so. Nothing reaches a persona or a room (or a floor).
 *  - `outageFor(scn, nodes, edges)`: the blast radius of a playing scenario's `down` (scenario.js `snapshot().down`),
 *    worked out once per down list and map; null for a scenario that is no outage. scene.js lights it.
 *  - `paintOutage(scene, radius)`: the colours on a built scene: run hits red, deploy amber, renew violet (each
 *    `WHEN_STYLES[when].color`), each walked edge in the colour of the hit it made, the down nodes black with
 *    their label struck through. It only recolours and brightens: what the radius does not reach stays dimmed.
 *  - `outageLayers(radius, nodes)`: the Layers keys its nodes are drawn on, for the player to turn on.
 *  - `outageScenario(node, nodes, edges)`: the cloud panel's Play button: a scenario that takes the node down,
 *    one step on it with its `breaks` line, then one step per hit group (now, the next deploy, the next renewal).
 *
 * The House view (CLOUD-08) reads the same radius: `hits` and `down` by node id, whatever the view draws.
 */

import { WHEN_STYLES, cloudUsedBy, externalLayer, nounOf, whenOf } from './cloud-model.js';

/** The `when`s, strongest first; a hit's rank is its index here */
const WHENS = Object.keys(WHEN_STYLES);
const RANK = Object.fromEntries(WHENS.map((w, i) => [w, i]));
/** What an outage never reaches (spec 0031 section 8): who uses the house, and where */
const NEVER_HIT = new Set(['persona', 'room', 'floor']);
/** The order hits are listed in within a group: outside first, then the house, then the code, then the sites */
const TYPE_ORDER = ['external', 'machine', 'container', 'service', 'page', 'app'];
const typeRank = (type) => { const i = TYPE_ORDER.indexOf(type); return i < 0 ? TYPE_ORDER.length : i; };

/** How a down node and a hit look on the scene (the hit's colour is its `WHEN_STYLES[when].color`) */
export const OUTAGE_DOWN = { color: '#050608', halo: 'child' };
const HIT = { alpha: 0.92, glow: 10, edgeAlpha: 0.9, edgeWidth: 2.2 };

const edgeKeyOf = (from, to) => `${from}->${to}`;

/**
 * @typedef {{ when: string, browser: boolean }} Hit
 * @typedef {object} BlastRadius
 * @property {string[]} down                  the down ids the map has, each once
 * @property {Map<string, Hit>} hits          every node the outage breaks (never a down one), by id
 * @property {Map<string, string>} edges      `from->to` of each edge the walk followed: the `when` of the hit it made
 * @property {{ when: string, title: string, color: string, ids: string[] }[]} groups  the hits by `when`, strongest first, only those with any
 */

/**
 * @param {string[]} down the ids of the cloud nodes that are down
 * @param {object[]} nodes
 * @param {object[]} edges
 * @returns {BlastRadius}
 */
export function blastRadius(down, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const downIds = [...new Set(Array.isArray(down) ? down : [])].filter((id) => byId.has(id));
  const downSet = new Set(downIds);

  // Who depends on what: target id -> [{ from, rank, browser, key }]; and the apps each stack service serves
  const deps = new Map();
  const depend = (to, d) => { if (!deps.has(to)) deps.set(to, []); deps.get(to).push(d); };
  const apps = new Map();
  for (const e of edges) {
    if (!e || !e.from || !e.to) continue;
    if (e.kind === 'calls') depend(e.to, { from: e.from, rank: RANK[whenOf(e)], browser: e.side === 'browser', key: edgeKeyOf(e.from, e.to) });
    else if (e.kind === 'triggers' && (byId.get(e.from) || {}).type === 'page' && (byId.get(e.to) || {}).type === 'service') {
      depend(e.to, { from: e.from, rank: 0, browser: false, key: edgeKeyOf(e.from, e.to) });
    } else if (e.kind === 'runs-on' && Array.isArray(e.mappings)) {
      for (const m of e.mappings) {
        if (!m || !m.service) continue;
        const k = `${e.to}|${m.service}`;
        if (!apps.has(k)) apps.set(k, new Set());
        apps.get(k).add(e.from);
      }
    }
  }
  const dependents = (id) => {
    const list = deps.get(id) || [];
    const n = byId.get(id);
    if (!n || n.type !== 'container' || !n.stack || !n.service) return list;
    const served = [...(apps.get(`stack-${n.stack}|${n.service}`) || [])].map((from) => ({ from, rank: 0, browser: false, key: null }));
    return served.length ? [...list, ...served] : list;
  };

  /** @type {Map<string, Hit & { rank: number }>} */
  const best = new Map();
  const walked = new Map();
  const buckets = WHENS.map(() => []);
  downIds.forEach((id) => buckets[0].push({ id, rank: 0, browser: false }));
  for (let r = 0; r < buckets.length; r++) {
    for (let i = 0; i < buckets[r].length; i++) {
      const { id, rank, browser } = buckets[r][i];
      const now = best.get(id);
      if (now && (now.rank < rank || (now.rank === rank && now.browser !== browser))) continue; // a stronger (or a server) path got here since
      for (const d of dependents(id)) {
        const from = byId.get(d.from);
        if (!from || downSet.has(d.from) || NEVER_HIT.has(from.type)) continue;
        const nr = Math.max(rank, d.rank);
        const nb = browser || d.browser;
        if (d.key && (!walked.has(d.key) || RANK[walked.get(d.key)] > nr)) walked.set(d.key, WHENS[nr]);
        const cur = best.get(d.from);
        if (cur && (cur.rank < nr || (cur.rank === nr && (!cur.browser || nb)))) continue;
        best.set(d.from, { rank: nr, when: WHENS[nr], browser: nb });
        buckets[nr].push({ id: d.from, rank: nr, browser: nb });
      }
    }
  }

  const hits = new Map([...best].map(([id, h]) => [id, { when: h.when, browser: h.browser }]));
  const label = (id) => String(byId.get(id).label || id);
  const groups = WHENS.map((when) => {
    const ids = [...hits].filter(([, h]) => h.when === when).map(([id]) => id)
      .sort((a, b) => typeRank(byId.get(a).type) - typeRank(byId.get(b).type) || label(a).localeCompare(label(b)));
    const { title, color } = WHEN_STYLES[when];
    return { when, title, color, ids };
  }).filter((g) => g.ids.length);
  return { down: downIds, hits, edges: walked, groups };
}

let memo = null;
/**
 * The blast radius of a scenario snapshot's `down` over a map, or null when it takes nothing down. Kept for the
 * last down list and map (the same arrays), so a scene rebuilt for every step does not walk the map again.
 */
export function outageFor(scn, nodes, edges) {
  const down = scn && Array.isArray(scn.down) ? scn.down : [];
  if (!down.length) return null;
  const key = down.join('\u0000');
  if (memo && memo.key === key && memo.nodes === nodes && memo.edges === edges) return memo.radius;
  memo = { key, nodes, edges, radius: blastRadius(down, nodes, edges) };
  return memo.radius;
}

/**
 * Colours an outage on a built scene (scene.js calls it after the scenario's own emphasis): every hit node in its
 * `when`'s colour, bright and labelled; every walked edge in the colour of the hit it made; each down node black
 * with its label struck through (keeping the current step's halo). Nothing else changes; a null radius changes nothing.
 * @param {{ nodes: object[], edges: object[] }} scene
 * @param {BlastRadius | null} radius
 */
export function paintOutage(scene, radius) {
  if (!radius) return;
  const downSet = new Set(radius.down);
  for (const n of scene.nodes) {
    if (downSet.has(n.id)) {
      Object.assign(n, { color: OUTAGE_DOWN.color, alpha: 1, labelAlpha: 1, labelColor: '#f8fafc', labelKeep: true, labelStrike: true, connected: true, glow: 0 });
      if (n.halo === 'none') n.halo = OUTAGE_DOWN.halo;
      continue;
    }
    const hit = radius.hits.get(n.id);
    if (!hit) continue;
    const alpha = Math.max(n.alpha, HIT.alpha);
    Object.assign(n, { color: WHEN_STYLES[hit.when].color, alpha, labelAlpha: alpha, labelColor: '#f8fafc', labelKeep: true, connected: true, glow: Math.max(n.glow || 0, HIT.glow) });
  }
  for (const e of scene.edges) {
    const when = radius.edges.get(edgeKeyOf(e.from, e.to));
    if (!when) continue;
    const color = WHEN_STYLES[when].color;
    e.color = color;
    if (e.glow) e.glowColor = color;
    e.alpha = Math.max(e.alpha, HIT.edgeAlpha);
    e.width = Math.max(e.width, HIT.edgeWidth);
    if (e.packet) e.packet = { ...e.packet, glowColor: color };
  }
}

/** The Layers keys the down nodes and the hits are drawn on (layers.js), each once: what the player turns on */
export function outageLayers(radius, nodes) {
  if (!radius) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keys = new Set();
  for (const id of [...radius.down, ...radius.hits.keys()]) {
    const n = byId.get(id);
    if (n) keys.add(n.type === 'external' ? externalLayer(n) : n.type);
  }
  return [...keys];
}

// ---------------------------------------------------------------------------
//  The generated scenario
// ---------------------------------------------------------------------------
/** Up to this many of one kind are named; more are counted */
const NAME_AT = 3;
const BROWSER = ' (in the visitor\'s browser)';

/** "a, b and c"; parts that hold an "and" of their own are kept apart with a comma ("the apps a and b, and the container c") */
function andList(words) {
  if (words.length < 2) return words.join('');
  const glue = words.some((w) => w.includes(' and ')) ? ', and ' : ' and ';
  return `${words.slice(0, -1).join(', ')}${glue}${words[words.length - 1]}`;
}

/** Hits of one group as words: "the container cloudflared and the machine server-1", "13 containers and 2 apps" */
function describe(items) {
  const byType = new Map();
  for (const it of items) { if (!byType.has(it.type)) byType.set(it.type, []); byType.get(it.type).push(it); }
  const parts = [...byType].sort(([ta, a], [tb, b]) => b.length - a.length || typeRank(ta) - typeRank(tb) || ta.localeCompare(tb)).map(([type, list]) => {
    const noun = nounOf(type, list.length);
    if (list.length > NAME_AT) {
      const browsers = list.filter((i) => i.browser).length;
      return `${list.length} ${noun}${browsers === list.length ? BROWSER : browsers ? ` (${browsers} in the visitor's browser)` : ''}`;
    }
    return `the ${noun} ${andList(list.map((i) => `${i.label}${i.browser ? BROWSER : ''}`))}`;
  });
  return andList(parts);
}

/**
 * The Play button's scenario for one cloud node (spec 0031 section 8): it takes the node down; the first step is
 * on the node with its `breaks` line; then one step per hit group, strongest first, on a call from one of the
 * node's own users when the group has one (else on its first hit), naming the direct users and then what breaks
 * through them. Validates as a proposal scenario on any map that has the node (its steps are the map's own).
 * @returns {{ id: string, title: string, down: string[], steps: object[] }}
 */
export function outageScenario(node, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const name = String(node.label || node.id);
  const radius = blastRadius([node.id], nodes, edges);
  const hitAs = (when) => (i) => radius.hits.has(i.id) && radius.hits.get(i.id).when === when; // a user with a stronger path elsewhere is listed there
  const direct = new Map(cloudUsedBy(node, nodes, edges).map((g) => [g.when, g.types.flatMap((t) => t.items).filter(hitAs(g.when)).map((i) => ({ ...i, browser: radius.hits.get(i.id).browser }))]));
  const opening = [`${name} is down.`, node.breaks ? String(node.breaks) : '', radius.groups.length ? '' : 'Nothing on the map uses it.'].filter(Boolean).join(' ');
  const steps = [{ node: node.id, text: opening }];
  for (const group of radius.groups) {
    const own = direct.get(group.when) || [];
    const ownIds = new Set(own.map((i) => i.id));
    const through = group.ids.filter((id) => !ownIds.has(id)).map((id) => {
      const n = byId.get(id);
      return { id, label: String(n.label || id), type: n.type, browser: radius.hits.get(id).browser };
    });
    let text;
    if (own.length) text = `${group.title}: ${describe(own)}.${through.length ? ` Through ${own.length === 1 ? 'it' : 'them'}: ${describe(through)}.` : ''}`;
    else text = `${group.title}, through what uses it: ${describe(through)}.`;
    steps.push(own.length ? { edge: { from: own[0].id, to: node.id, kind: 'calls' }, text } : { node: group.ids[0], text });
  }
  return { id: `outage-${node.id}`, title: `${name} is down`, down: [node.id], steps };
}
