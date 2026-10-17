/**
 * The scenario player and an outage (spec 0031 section 8, CLOUD-01): a scenario's `down` is read
 * and handed on in every snapshot, for the blast radius (CLOUD-07) to draw; a scenario without one
 * plays as before.
 */
import { describe, it, expect } from 'vitest';
import { createPlayer, scenarioDown } from '../../explorer/scenario.js';

const steps = [{ node: 'ext-cloudflare', text: 'It goes down.' }, { node: 'container-caddy', text: 'Caddy keeps serving.' }];

describe('a scenario\'s down', () => {
  it('reads the down node ids, each once, and nothing that is not an id', () => {
    expect(scenarioDown({ id: 's', title: 'S', steps, down: ['ext-cloudflare', 'ext-registrar'] })).toEqual(['ext-cloudflare', 'ext-registrar']);
    expect(scenarioDown({ id: 's', title: 'S', steps, down: ['ext-cloudflare', 'ext-cloudflare', '', 7]        })).toEqual(['ext-cloudflare']);
    expect(scenarioDown({ id: 's', title: 'S', steps })).toEqual([]);
    expect(scenarioDown({ id: 's', title: 'S', steps, down: 'ext-cloudflare' }       )).toEqual([]);
    expect(scenarioDown(null       )).toEqual([]);
  });

  it('is in every snapshot, from the first step on, and the scenario is not changed', () => {
    const scenario = { id: 'cloudflare-is-down', title: 'Cloudflare is down', steps, down: ['ext-cloudflare'] };
    const player = createPlayer(scenario, { stepMs: 'manual' });
    expect(player.snapshot().down).toEqual(['ext-cloudflare']);
    player.next();
    expect(player.snapshot().down).toEqual(['ext-cloudflare']);
    player.snapshot().down.push('ext-x');
    expect(scenario.down).toEqual(['ext-cloudflare']);
    expect(player.snapshot().down).toEqual(['ext-cloudflare']);
  });

  it('is empty for a scenario that is no outage, which plays as before', () => {
    const player = createPlayer({ id: 's', title: 'S', steps });
    const snap = player.snapshot();
    expect(snap.down).toEqual([]);
    expect(snap.visited.nodes).toEqual(new Set(['ext-cloudflare']));
    expect(snap.current).toEqual({ text: 'It goes down.', node: 'ext-cloudflare' });
  });

  it('follows an edited scenario', () => {
    const player = createPlayer({ id: 's', title: 'S', steps });
    player.setScenario({ id: 's', title: 'S', steps, down: ['ext-ghcr'] });
    expect(player.snapshot().down).toEqual(['ext-ghcr']);
  });
});
