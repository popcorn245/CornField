/**
 * @module explorer/outage-scenario
 *
 * What the scenario player does with an outage (spec 0031 section 8, CLOUD-07): the Layers keys an outage is drawn on (`outageLayers`) and the
 * Play button's scenario for one cloud node (`outageScenario`), made from outage-model.js's blast radius. Only the player and cornfield's page
 * play one, so a map alone, which paints an outage scenario's radius (scene.js, `outageFor`, `paintOutage`), does not carry this (the
 * components' size budget, spec 0011 D11). Pure: no DOM, no state.
 */

import { externalLayer } from './cloud-model.js';
import { cloudUsedBy, nounOf } from './cloud-panel.js';
import { blastRadius, typeRank } from './outage-model.js';

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
