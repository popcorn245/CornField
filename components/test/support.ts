// Helpers for the tests that run in a real browser. The topology is the synthetic fixture's map (served by scripts/shared.mjs demoTopology).
import '../src/index';

export type CornMapElement = HTMLElement & {
  topology: unknown; node: string | null | undefined; view: string; theme: string | undefined; renderer: string;
  componentOnReady(): Promise<CornMapElement>;
  fit(): Promise<void>; focusNode(id: string): Promise<void>; refresh(): Promise<void>;
};

let cached: Promise<{ nodes: Array<{ id: string; [k: string]: unknown }>; edges: unknown[] }> | null = null;
/** The synthetic fixture's map (922 nodes) */
export function bigTopology() {
  cached ||= fetch('/demo/topology.json').then((r) => r.json());
  return cached;
}
/** A handful of that map: the first nodes, and the edges between them (so a test can find a node by scanning a small picture) */
export async function smallTopology(count = 14) {
  const big = await bigTopology();
  const nodes = big.nodes.slice(0, count);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes: structuredClone(nodes), edges: (big.edges as Array<{ from: string; to: string }>).filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

export const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
export async function frames(n = 3) { for (let i = 0; i < n; i++) await frame(); }
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A corn-map in the page with a box of its own, once its first frame is drawn */
export async function mountMap(attrs: Record<string, string> = {}, { topology, style = 'width: 600px; height: 400px', parent = document.body }: { topology?: unknown; style?: string; parent?: Element } = {}) {
  const el = document.createElement('corn-map') as CornMapElement;
  el.setAttribute('style', style);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.append(el);
  await el.componentOnReady();
  if (topology !== undefined) {
    const ready = new Promise<void>((resolve) => el.addEventListener('cornReady', () => resolve(), { once: true }));
    el.topology = topology;
    await ready;
    await frames(2);
    // Chrome draws a 2d canvas on the GPU until it is first read, and the pixels it draws then are not the ones it drew before: read once, draw again, and the pictures of a test are steady
    if (attrs.renderer === 'canvas2d') { pixelsOf(canvasOf(el)); await el.fit(); await steady(canvasOf(el)); }
  }
  return el;
}

/** The map canvas inside an element's shadow root */
export const canvasOf = (el: HTMLElement) => el.shadowRoot!.querySelector('canvas[data-corn="map-canvas"]') as HTMLCanvasElement;

/** A hash of what a 2d canvas shows (not for a WebGL one: its buffer is not readable after it is presented) */
export function pixelsOf(canvas: HTMLCanvasElement) {
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261;
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]) lit++;
    hash = Math.imul(hash ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)), 16777619);
  }
  return { hash, lit };
}

/** Waits until the picture has stopped changing (a glyph or an icon that arrives late draws again), and returns it */
export async function steady(canvas: HTMLCanvasElement) {
  let last = pixelsOf(canvas).hash;
  for (let same = 0, i = 0; same < 3 && i < 60; i++) {
    await sleep(60);
    const now = pixelsOf(canvas).hash;
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return pixelsOf(canvas);
}

/** Declarations that give every kind of node in smallTopology()'s first nodes one colour (the map reads `--corn-map-node-<kind>` from the element) */
export const paintNodes = (color: string) => ['root', 'store', 'core', 'tool', 'pkg'].map((k) => `--corn-map-node-${k}: ${color};`).join(' ');

/** The computed value of a custom property on an element */
export const tokenOf = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();

declare module 'vitest/browser' {
  interface BrowserCommands {
    colorScheme(scheme: 'light' | 'dark'): Promise<void>;
    viewport(width: number, height: number): Promise<void>;
  }
}
