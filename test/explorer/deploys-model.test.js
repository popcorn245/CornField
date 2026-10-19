/**
 * @vitest-environment node
 *
 * Deploys on the map without a page (PIPE-03, explorer/forge-panel-model.js): the nodes a deploy restarted from the
 * refs the config gave it (an id, else a label; a stack brings its containers), what it lights, the list's filters and
 * words, and the paint it shares with pull requests.
 */
import { describe, it, expect } from 'vitest';
import {
  nodesForRestarts, litForDeploy, matchesDeploy, filterItems, deployWords, deployMeta, listUrl, listKeyOf, defaultFilters, STATES, paintForge, FORGE_FAIL_COLOR,
  // @ts-expect-error plain JS modules, no declarations
} from '../../explorer/forge-panel-model.js';

const NODES = [
  { id: 'root', type: 'root', label: 'root' },
  { id: 'machine-nas', type: 'machine', label: 'nas' },
  { id: 'stack-media', type: 'stack', label: 'media' },
  { id: 'container-media-jellyfin', type: 'container', label: 'jellyfin', stack: 'media' },
  { id: 'container-media-sonarr', type: 'container', label: 'sonarr', stack: 'media' },
  { id: 'stack-web', type: 'stack', label: 'web' },
  { id: 'container-web-app', type: 'container', label: 'app', stack: 'web' },
  { id: 'container-app', type: 'container', label: 'app', stack: 'other' },
];
const ids = (nodes) => nodes.map((n) => n.id);
const deploy = (extra = {}) => ({
  id: '1', workflow: 'deploy.yml', name: 'Deploy', title: 'Ship it', event: 'push', branch: 'main', sha: 'abc1234def', state: 'success', actor: { login: 'maintainer-one', url: null },
  url: null, createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T11:00:00Z', restarts: [], ...extra,
});

describe('nodesForRestarts', () => {
  it('finds a node by its id, a stack bringing its containers (and only its own)', () => {
    const { nodes, missing } = nodesForRestarts(['stack-media'], NODES);
    expect(ids(nodes)).toEqual(['stack-media', 'container-media-jellyfin', 'container-media-sonarr']);
    expect(missing).toEqual([]);
  });

  it('finds a node by its label when no id is that, whatever the case, every node with it; an id wins over a label', () => {
    expect(ids(nodesForRestarts(['NAS'], NODES).nodes)).toEqual(['machine-nas']);
    expect(ids(nodesForRestarts(['app'], NODES).nodes)).toEqual(['container-web-app', 'container-app']);
    expect(ids(nodesForRestarts(['container-app'], NODES).nodes)).toEqual(['container-app']);
    expect(ids(nodesForRestarts(['web'], NODES).nodes)).toEqual(['stack-web', 'container-web-app']);
  });

  it('names what the map does not have, keeps the rest, and lists each node once', () => {
    const { nodes, missing } = nodesForRestarts(['ghost', 'media', 'stack-media', 'also-ghost'], NODES);
    expect(ids(nodes)).toEqual(['stack-media', 'container-media-jellyfin', 'container-media-sonarr']);
    expect(missing).toEqual(['ghost', 'also-ghost']);
    expect(nodesForRestarts([], NODES)).toEqual({ nodes: [], missing: [] });
  });
});

describe('litForDeploy', () => {
  it('lights what a deploy restarted as changed, and what a failed one restarted as failing', () => {
    const ok = litForDeploy(deploy({ restarts: ['nas'] }), NODES);
    expect([[...ok.changed], [...ok.failing]]).toEqual([['machine-nas'], []]);
    const bad = litForDeploy(deploy({ state: 'failure', restarts: ['nas', 'ghost'] }), NODES);
    expect([[...bad.changed], [...bad.failing], bad.missing]).toEqual([[], ['machine-nas'], ['ghost']]);
    for (const state of ['running', 'queued', 'cancelled', 'skipped']) expect(litForDeploy(deploy({ state, restarts: ['nas'] }), NODES).changed.size).toBe(1);
  });

  it('lights nothing for a deploy that is not mapped (and a missing list is the same)', () => {
    const none = litForDeploy(deploy(), NODES);
    expect([none.nodes, none.changed.size, none.failing.size]).toEqual([[], 0, 0]);
    expect(litForDeploy({ state: 'success' }, NODES).nodes).toEqual([]);
  });

  it('paints through the pull request path: lit nodes bright (a failed deploy red), the rest faded', () => {
    const make = (lit) => {
      const s = { nodes: NODES.map((n) => ({ id: n.id, alpha: 1, labelAlpha: 1, glow: 0, halo: null, color: '#336699' })), edges: [{ from: 'root', to: 'machine-nas', alpha: 1 }, { from: 'root', to: 'stack-web', alpha: 1 }] };
      paintForge(s, lit);
      return s;
    };
    const ok = make(litForDeploy(deploy({ restarts: ['nas'] }), NODES));
    expect(ok.nodes.find((n) => n.id === 'machine-nas')).toMatchObject({ alpha: 1, halo: 'match' });
    expect(ok.nodes.find((n) => n.id === 'root').alpha).toBeLessThan(0.5);
    expect(ok.edges[1].alpha).toBeLessThan(0.2);
    const bad = make(litForDeploy(deploy({ state: 'failure', restarts: ['nas'] }), NODES));
    expect(bad.nodes.find((n) => n.id === 'machine-nas').color).toBe(FORGE_FAIL_COLOR);
    const none = make(litForDeploy(deploy(), NODES));
    expect(none.nodes.every((n) => n.alpha === 1)).toBe(true);
  });
});

describe('the deploys list', () => {
  const list = [deploy({ id: '4' }), deploy({ id: '3', state: 'failure', name: 'Deploy nas', branch: 'v2' }), deploy({ id: '2', state: 'running' }), deploy({ id: '1', state: 'queued' }),
    deploy({ id: '0', state: 'cancelled', actor: null }), deploy({ id: '-1', state: 'skipped' })];

  it('is asked for by address, kept as one list whatever the state filter says, and starts on All', () => {
    expect(listUrl('deploys', 'failure')).toBe('/api/forge/deploys?limit=100');
    expect(listKeyOf('deploys', 'failure')).toBe('deploys');
    expect(listKeyOf('pulls', 'merged')).toBe('pulls|closed');
    expect(defaultFilters('deploys').state).toBe('all');
    expect(defaultFilters().state).toBe('open');
    expect(STATES.deploys.map(([v]) => v)).toEqual(['all', 'success', 'failure', 'running', 'other']);
  });

  it('filters by state (waiting counts as running; cancelled and skipped are other) and by a search over its words', () => {
    const f = (state, text = '') => filterItems(list, 'deploys', { ...defaultFilters('deploys'), state, text }).map((d) => d.id);
    expect(f('all')).toEqual(['4', '3', '2', '1', '0', '-1']);
    expect(f('success')).toEqual(['4']);
    expect(f('failure')).toEqual(['3']);
    expect(f('running')).toEqual(['2', '1']);
    expect(f('other')).toEqual(['0', '-1']);
    expect(f('all', 'nas v2')).toEqual(['3']);
    expect(f('all', 'abc1234')).toHaveLength(6);
    expect(f('all', 'maintainer')).toEqual(['4', '3', '2', '1', '-1']); // one has no actor
    expect(matchesDeploy(list[0], { text: 'zzz' })).toBe(false);
  });

  it('says a deploy\'s state in a word, and its branch, commit, who and when in a line', () => {
    expect(list.map(deployWords)).toEqual(['Succeeded', 'Failed', 'Running', 'Waiting', 'Cancelled', 'Skipped']);
    expect(deployWords({ state: 'odd' })).toBe('odd');
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect(deployMeta(list[0], now)).toBe('main · abc1234 · maintainer-one · 1 hour ago');
    expect(deployMeta({ ...list[0], actor: null, branch: '' }, now)).toBe('abc1234 · 1 hour ago');
  });
});
