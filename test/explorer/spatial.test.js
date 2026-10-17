/**
 * The spatial index behind hover, click and drag (TOPO-06). Pure, so the default node
 * environment: no DOM, no canvas.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { createSpatialIndex, createSpatialCache, hitTestScreen } from '../../explorer/spatial.js';


const item = (id        , x        , y        , r = 10)       => ({ id, x, y, r });

/** What input.js did before: a scan from the last node to the first, in screen pixels */
function linearScan(items        , camera                                        , sx        , sy        , touch         ) {
  const minTouchRadius = touch ? 32 : 12;
  for (let i = items.length - 1; i >= 0; i--) {
    const n = items[i];
    const dist = Math.hypot(camera.x + n.x * camera.zoom - sx, camera.y + n.y * camera.zoom - sy);
    if (dist <= Math.max(n.r * camera.zoom + (touch ? 16 : 6), minTouchRadius)) return n;
  }
  return null;
}

/** A small seeded generator (mulberry32): the same numbers on every run */
function seeded(seed        ) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthetic(count        , seed = 7)         {
  const rand = seeded(seed);
  const out         = [];
  for (let i = 0; i < count; i++) {
    // a disc of nodes around the origin, radii like the explorer's (6 to 30), some negative coordinates
    const angle = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand()) * 4000;
    out.push(item(`n${i}`, Math.cos(angle) * dist, Math.sin(angle) * dist, 6 + rand() * 24));
  }
  return out;
}

describe('createSpatialIndex', () => {
  it('finds the node under a point and nothing where there is none', () => {
    const a = item('a', 100, 100);
    const b = item('b', 300, 100);
    const index = createSpatialIndex([a, b]);
    expect(index.size).toBe(2);
    expect(index.nodeAt(100, 100)).toBe(a);
    expect(index.nodeAt(105, 105)).toBe(a);
    expect(index.nodeAt(300, 109)).toBe(b);
    expect(index.nodeAt(200, 100)).toBeNull();
    expect(index.nodeAt(100, 111)).toBeNull(); // just outside r = 10
    expect(index.nodeAt(-5000, 5000)).toBeNull();
  });

  it('answers the topmost node when circles overlap: the later one in draw order', () => {
    const under = item('under', 100, 100, 20);
    const over = item('over', 110, 100, 20);
    expect(createSpatialIndex([under, over]).nodeAt(105, 100)).toBe(over);
    expect(createSpatialIndex([over, under]).nodeAt(105, 100)).toBe(under);
    // a point only the lower circle holds still finds it
    expect(createSpatialIndex([under, over]).nodeAt(85, 100)).toBe(under);
    // ... and the order holds when the two sit in different cells
    const far = createSpatialIndex([item('a', 63, 0, 20), item('b', 66, 0, 20)], { cellSize: 64 });
    expect(far.nodeAt(64, 0) .id).toBe('b');
  });

  it('finds a node whose circle spans several cells from any of them', () => {
    const big = item('big', 0, 0, 200);
    const index = createSpatialIndex([big], { cellSize: 64 });
    expect(index.nodeAt(190, 0)).toBe(big);
    expect(index.nodeAt(-100, -150)).toBe(big);
    expect(index.nodeAt(0, 199)).toBe(big);
    expect(index.nodeAt(150, 150)).toBeNull(); // inside the bounding box, outside the circle
    expect(index.nodeAt(0, 201)).toBeNull();
  });

  it('handles negative coordinates and a node exactly on a cell edge', () => {
    const a = item('a', -64, -64, 10);
    const b = item('b', -1, -130, 10);
    const index = createSpatialIndex([a, b], { cellSize: 64 });
    expect(index.nodeAt(-64, -64)).toBe(a);
    expect(index.nodeAt(-70, -70)).toBe(a);
    expect(index.nodeAt(-1, -130)).toBe(b);
    expect(index.nodeAt(1, -124)).toBe(b);
    expect(index.nodeAt(0, 0)).toBeNull();
  });

  it('an empty index answers null and []', () => {
    const index = createSpatialIndex([]);
    expect(index.size).toBe(0);
    expect(index.nodeAt(0, 0)).toBeNull();
    expect(index.nodeAt(0, 0, { pad: 50, min: 50 })).toBeNull();
    expect(index.nodesIn({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 })).toEqual([]);
  });

  it('slop widens the hit: a number adds to every radius, { pad, min } also sets a floor', () => {
    const small = item('small', 0, 0, 4);
    const index = createSpatialIndex([small]);
    expect(index.nodeAt(10, 0)).toBeNull();
    expect(index.nodeAt(10, 0, 6)).toBe(small); // 4 + 6
    expect(index.nodeAt(10.5, 0, 6)).toBeNull();
    expect(index.nodeAt(10, 0, { pad: 2, min: 12 })).toBe(small); // max(4 + 2, 12)
    expect(index.nodeAt(12.5, 0, { pad: 2, min: 12 })).toBeNull();
    expect(index.nodeAt(200, 0, { pad: 2, min: 250 })).toBe(small); // a floor wider than many cells
  });

  it('nodesIn lists every node whose circle touches the rectangle, in draw order', () => {
    const items = [item('a', 0, 0), item('b', 100, 100), item('c', 150, 0, 30), item('d', -500, -500), item('e', 52, 0, 5)];
    const index = createSpatialIndex(items, { cellSize: 64 });
    expect(index.nodesIn({ minX: -20, minY: -20, maxX: 60, maxY: 20 }).map((n      ) => n.id)).toEqual(['a', 'e']);
    // c's centre is outside the rectangle but its circle reaches in
    expect(index.nodesIn({ minX: 100, minY: -10, maxX: 125, maxY: 10 }).map((n      ) => n.id)).toEqual(['c']);
    expect(index.nodesIn({ minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 }).map((n      ) => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(index.nodesIn({ minX: 300, minY: 300, maxX: 400, maxY: 400 })).toEqual([]);
    expect(index.nodesIn({ minX: -520, minY: -520, maxX: -480, maxY: -480 }).map((n      ) => n.id)).toEqual(['d']);
  });

  it('answers what the old linear scan answered, at every zoom, for a mouse and a finger', () => {
    const items = synthetic(600, 3);
    const index = createSpatialIndex(items);
    const rand = seeded(11);
    let hits = 0;
    for (let i = 0; i < 4000; i++) {
      const camera = { x: rand() * 800 - 400, y: rand() * 600 - 300, zoom: 0.25 + rand() * 2.75 };
      const touch = rand() < 0.5;
      // aim near a node half the time so there are hits to compare
      const target = items[Math.floor(rand() * items.length)];
      const near = rand() < 0.5;
      const sx = near ? camera.x + target.x * camera.zoom + (rand() - 0.5) * 80 : rand() * 1400 - 200;
      const sy = near ? camera.y + target.y * camera.zoom + (rand() - 0.5) * 80 : rand() * 900 - 200;
      const expected = linearScan(items, camera, sx, sy, touch);
      const got = hitTestScreen(index, camera, sx, sy, touch);
      if (expected) hits++;
      expect(got?.id ?? null).toBe(expected?.id ?? null);
    }
    expect(hits).toBeGreaterThan(500); // the comparison compared real hits, not only misses
  });
});

describe('createSpatialCache', () => {
  it('builds again only for a different scene', () => {
    const cache = createSpatialCache();
    const scene1 = { version: 1, nodes: [item('a', 0, 0)] };
    const scene2 = { version: 2, nodes: [item('a', 0, 0), item('b', 50, 0)] };
    const first = cache.get(scene1);
    expect(cache.get(scene1)).toBe(first);
    expect(cache.get(scene1)).toBe(first);
    expect(cache.builds).toBe(1);
    expect(cache.get(scene2).size).toBe(2);
    expect(cache.builds).toBe(2);
  });
});

describe('the index on 5,000 nodes', () => {
  // Bounds are loose on purpose: a busy CI box must not flake. Measured on the dev box (Ryzen):
  // build ~1.4 ms, nodeAt ~0.002 ms, so these allow 14x and 25x of that.
  const BUILD_MS = 20;
  const NODE_AT_AVG_MS = 0.05;

  it(`builds in under ${BUILD_MS} ms and answers nodeAt in under ${NODE_AT_AVG_MS} ms on average`, () => {
    const items = synthetic(5000, 42);
    createSpatialIndex(items); // warm up the JIT: the first build is not the one a user waits for twice
    let build = Infinity;
    let index     ;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      index = createSpatialIndex(items);
      build = Math.min(build, performance.now() - t0);
    }
    expect(index.size).toBe(5000);
    expect(build).toBeLessThan(BUILD_MS);

    const rand = seeded(5);
    const queries = Array.from({ length: 20000 }, () => [rand() * 8800 - 4400, rand() * 8800 - 4400]);
    for (let i = 0; i < 2000; i++) index.nodeAt(queries[i][0], queries[i][1], { pad: 6, min: 12 }); // warm up
    const slop = { pad: 6, min: 12 };
    const t0 = performance.now();
    let found = 0;
    for (const [x, y] of queries) if (index.nodeAt(x, y, slop)) found++;
    const avg = (performance.now() - t0) / queries.length;
    expect(found).toBeGreaterThan(0);
    expect(avg).toBeLessThan(NODE_AT_AVG_MS);
  });
});
