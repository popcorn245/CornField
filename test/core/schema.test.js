/**
 * The physical world in the schema (spec 0029 section 1, PHY-01): the six node types and their
 * themes, the live types and the live-id grammar, and the widened `runs-on`, `delivers` and dashed
 * placement rules, read by `topology.js validate` and by the proposal checks.
 */
import { describe, it, expect } from 'vitest';
import {
  NODE_THEMES, EDGE_KINDS, DEVICE_KINDS, LIVE_TYPES, EDGE_ENDS, PLACEMENT_ENDS,
  parseLiveId, isLiveNode, committedNodeProblems, endsAllowed, describeEnds, personaNodeId,
} from '../../core/schema.js';
import { validateTopology } from '../../core/validate.js';
import { loadSample } from '../helpers.js';

describe('the six node types of the physical world', () => {
  it('have the themes of the visual spec', () => {
    expect(NODE_THEMES.machine).toEqual({ color: '#78716c', r: 26 });
    expect(NODE_THEMES.container).toEqual({ color: '#d6d3d1', r: 12 });
    expect(NODE_THEMES.persona).toEqual({ color: '#fb7185', r: 22 });
    expect(NODE_THEMES.device).toEqual({ color: '#2dd4bf', r: 14 });
    expect(NODE_THEMES.floor).toEqual({ color: '#a3e635', r: 20 });
    expect(NODE_THEMES.room).toEqual({ color: '#bef264', r: 16 });
  });

  it('add no edge kind: runs-on, delivers and ownership are widened instead (D1)', () => {
    expect(EDGE_KINDS).toEqual(['flow', 'reads', 'writes', 'uses', 'extends', 'calls', 'triggers', 'delivers', 'runs-on']);
  });

  it('tell devices apart by kind', () => {
    expect(DEVICE_KINDS).toEqual(['camera', 'phone', 'nfc-tag', 'home-assistant']);
  });

  it('name a persona node after its persona id', () => {
    expect(personaNodeId('child')).toBe('persona-child');
  });
});

describe('live ids and live nodes', () => {
  it('reads the live-id grammar: live-floor-<id>, live-room-<id>, live-device-<kind>-<id>', () => {
    expect(parseLiveId('live-floor-main')).toEqual({ type: 'floor', id: 'main' });
    expect(parseLiveId('live-room-living-room')).toEqual({ type: 'room', id: 'living-room' });
    expect(parseLiveId('live-device-nfc-tag-0a1b')).toEqual({ type: 'device', kind: 'nfc-tag', id: '0a1b' });
    expect(parseLiveId('live-device-home-assistant-kitchen-light')).toEqual({ type: 'device', kind: 'home-assistant', id: 'kitchen-light' });
    expect(parseLiveId('live-device-phone-7')).toEqual({ type: 'device', kind: 'phone', id: '7' });
  });

  it('refuses what is not in the grammar', () => {
    for (const id of ['live-room-', 'live-floor', 'live-device-toaster-1', 'live-device-phone-', 'room-kitchen', 'live-shed-1', '', undefined, 7]) {
      expect(parseLiveId(id       ), String(id)).toBeNull();
    }
  });

  it('a floor, a room, a device with no file and anything with a live- id is live', () => {
    expect(LIVE_TYPES).toEqual(['floor', 'room']);
    expect(isLiveNode({ id: 'x', type: 'floor' })).toBe(true);
    expect(isLiveNode({ id: 'x', type: 'room' })).toBe(true);
    expect(isLiveNode({ id: 'x', type: 'device', kind: 'phone' })).toBe(true);
    expect(isLiveNode({ id: 'live-anything', type: 'page' })).toBe(true);
    expect(isLiveNode({ id: 'device-camera-door', type: 'device', kind: 'camera', file: 'stacks/camera-stack/cameras.yml' })).toBe(false);
    for (const type of ['machine', 'container', 'persona', 'page']) expect(isLiveNode({ id: `${type}-x`, type }), type).toBe(false);
  });

  it('keeps live nodes out of topology.json, and holds a device to a known kind', () => {
    expect(committedNodeProblems({ id: 'machine-server-1', type: 'machine' })).toEqual([]);
    expect(committedNodeProblems({ id: 'device-camera-door', type: 'device', kind: 'camera', file: 'stacks/camera-stack/cameras.yml' })).toEqual([]);
    expect(committedNodeProblems({ id: 'live-room-kitchen', type: 'room' }).join()).toMatch(/live/);
    expect(committedNodeProblems({ id: 'floor-main', type: 'floor' }).join()).toMatch(/floor.*live layer/);
    expect(committedNodeProblems({ id: 'device-phone-1', type: 'device', kind: 'phone' }).join()).toMatch(/file/);
    expect(committedNodeProblems({ id: 'live-thing', type: 'page' }).join()).toMatch(/live-/);
    expect(committedNodeProblems({ id: 'device-x', type: 'device', kind: 'toaster', file: 'x' }).join()).toMatch(/kind/);
  });
});

describe('the edge ends', () => {
  it('widens runs-on: app -> stack as before, and stack, package or machine -> machine', () => {
    expect(EDGE_ENDS['runs-on']).toEqual([['app', 'stack'], ['stack', 'machine'], ['pkg', 'machine'], ['machine', 'machine']]);
    expect(endsAllowed(EDGE_ENDS['runs-on'], 'stack', 'machine')).toBe(true);
    expect(endsAllowed(EDGE_ENDS['runs-on'], 'machine', 'stack')).toBe(false);
  });

  it('widens delivers: external -> endpoint as before, and device -> container (container -> endpoint from spec 0031)', () => {
    expect(EDGE_ENDS.delivers).toEqual([['external', 'page'], ['device', 'container'], ['container', 'page']]);
    expect(endsAllowed(EDGE_ENDS.delivers, 'device', 'container')).toBe(true);
    expect(endsAllowed(EDGE_ENDS.delivers, 'device', 'page')).toBe(false);
  });

  it('places a machine or a device in a room with a dashed ownership edge', () => {
    expect(PLACEMENT_ENDS).toEqual([['room', 'machine'], ['room', 'device'], ['container', 'device'], ['external', 'device']]);
    expect(endsAllowed(PLACEMENT_ENDS, 'room', 'machine')).toBe(true);
    expect(endsAllowed(PLACEMENT_ENDS, 'floor', 'machine')).toBe(false);
  });

  it('places a Home Assistant service device on the container that serves its host, or on its cloud node (spec 0031 section 3.1)', () => {
    expect(endsAllowed(PLACEMENT_ENDS, 'container', 'device')).toBe(true);
    expect(endsAllowed(PLACEMENT_ENDS, 'external', 'device')).toBe(true);
    expect(endsAllowed(PLACEMENT_ENDS, 'container', 'machine')).toBe(false);
    expect(endsAllowed(PLACEMENT_ENDS, 'stack', 'device')).toBe(false);
  });

  it('describes the ends for a message', () => {
    expect(describeEnds(EDGE_ENDS['runs-on'])).toBe('app -> stack, stack -> machine, pkg -> machine, or machine -> machine');
    expect(describeEnds([['external', 'page']])).toBe('external -> page');
  });
});

describe('topology.js validate and the physical world', () => {
  const real = loadSample();
  const theme = (type        ) => ({ color: NODE_THEMES[type].color, r: NODE_THEMES[type].r });
  const extra = {
    nodes: [
      { id: 'machine-host-a', label: 'host-a', type: 'machine', ...theme('machine'), hostname: 'host-a', file: 'stacks/world.json', desc: 'A host.' },
      { id: 'machine-host-b', label: 'host-b', type: 'machine', ...theme('machine'), hostname: 'host-b', virtual: true, file: 'stacks/world.json', desc: 'A virtual host on host-a.' },
      { id: 'container-x', label: 'x', type: 'container', ...theme('container'), file: 'stacks/app-stack/docker-compose.yml', desc: 'A container.' },
      { id: 'device-camera-door', label: 'door', type: 'device', kind: 'camera', ...theme('device'), file: 'stacks/camera-stack/cameras.yml', desc: 'A camera.' },
      { id: 'persona-test-visitor', label: 'Visitor', type: 'persona', ...theme('persona'), file: 'topology.personas.json', desc: 'A visitor.' },
    ],
    edges: [
      { from: 'stack-app-stack', to: 'container-x' },
      { from: 'stack-app-stack', to: 'machine-host-b', kind: 'runs-on', label: 'runs on host-b' },
      { from: 'machine-host-b', to: 'machine-host-a', kind: 'runs-on', label: 'a virtual machine on host-a' },
      { from: 'device-camera-door', to: 'container-x', kind: 'delivers', label: 'stream' },
    ],
  };
  const withWorld = (more                                         = {}) => validateTopology({
    ...real,
    nodes: [...real.nodes, ...extra.nodes, ...(more.nodes || [])],
    edges: [...real.edges, ...extra.edges, ...(more.edges || [])],
  }).filter((e        ) => !e.startsWith('[OpenCollection]'));

  it('accepts machines, containers, a camera, a persona and the widened edges', () => {
    expect(withWorld()).toEqual([]);
  });

  it('accepts a package that runs on a machine', () => {
    const pkg = real.nodes.find((n     ) => n.type === 'pkg').id;
    expect(withWorld({ edges: [{ from: pkg, to: 'machine-host-a', kind: 'runs-on', label: 'runs on host-a' }] })).toEqual([]);
  });

  it('refuses a floor, a room, a device without a file and a live- id', () => {
    const errors = withWorld({
      nodes: [
        { id: 'live-floor-main', label: 'Main', type: 'floor', ...theme('floor'), desc: 'x' },
        { id: 'room-kitchen', label: 'Kitchen', type: 'room', ...theme('room'), desc: 'x' },
        { id: 'device-phone-1', label: 'Phone', type: 'device', kind: 'phone', ...theme('device'), desc: 'x' },
        { id: 'live-x', label: 'x', type: 'external', ...theme('external'), desc: 'x' },
      ],
    }).join('\n');
    expect(errors).toMatch(/live-floor-main/);
    expect(errors).toMatch(/room-kitchen/);
    expect(errors).toMatch(/device-phone-1/);
    expect(errors).toMatch(/live-x/);
  });

  it('refuses runs-on and delivers between the wrong ends, a mapping off app -> stack, and no label', () => {
    expect(withWorld({ edges: [{ from: 'machine-host-a', to: 'stack-app-stack', kind: 'runs-on', label: 'x' }] }).join()).toMatch(/must go app -> stack, stack -> machine/);
    expect(withWorld({ edges: [{ from: 'container-x', to: 'machine-host-a', kind: 'runs-on', label: 'x' }] }).join()).toMatch(/must go/);
    expect(withWorld({ edges: [{ from: 'stack-app-stack', to: 'machine-host-a', kind: 'runs-on', label: 'x', mappings: [{ host: 'a' }] }] }).join()).toMatch(/mappings.*only.*app -> stack/);
    expect(withWorld({ edges: [{ from: 'stack-app-stack', to: 'machine-host-a', kind: 'runs-on' }] }).join()).toMatch(/needs a label/);
    expect(withWorld({ edges: [{ from: 'device-camera-door', to: 'machine-host-a', kind: 'delivers', label: 'x' }] }).join()).toMatch(/external -> page, device -> container, or container -> page/);
  });

  it('still wants the mappings on app -> stack', () => {
    const app = real.edges.find((e     ) => e.kind === 'runs-on');
    expect(withWorld({ edges: [{ ...app, from: app.from, to: 'stack-app-stack', mappings: [] }] }).join()).toMatch(/needs 'mappings'/);
  });
});
