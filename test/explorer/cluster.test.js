// @vitest-environment node
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { clusterIds } from '../../explorer/cluster.js';

describe('a cluster (spec 0008 D1)', () => {
  const edges = [
    { from: 'root', to: 'app' }, { from: 'app', to: 'page1' }, { from: 'app', to: 'page2' }, { from: 'page1', to: 'sub' },
    { from: 'root', to: 'other' }, { from: 'page1', to: 'tbl', kind: 'reads' }, { from: 'app', to: 'used', dashed: true },
  ];
  it('is the hub and everything under it by ownership', () => {
    expect([...clusterIds('app', edges)].sort()).toEqual(['app', 'page1', 'page2', 'sub']);
    expect([...clusterIds('other', edges)]).toEqual(['other']);
  });
  it('leaves out what a line of another kind or a usage link reaches, and survives a loop', () => {
    expect(clusterIds('app', edges).has('tbl')).toBe(false);
    expect(clusterIds('app', edges).has('used')).toBe(false);
    expect([...clusterIds('a', [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])].sort()).toEqual(['a', 'b']);
  });
});
