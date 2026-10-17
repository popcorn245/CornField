/**
 * What the tests share: the sample repo (test/fixtures/sample, a small self-hosted repo with packages, one
 * stack on one machine, personas, a cloud registry, a house file and a proposal) and readers for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORNFIELD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLE = path.join(CORNFIELD, 'test', 'fixtures', 'sample');
export const EXPLORER = path.join(CORNFIELD, 'explorer');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The sample repo's committed map */
export const loadSample = () => readJson(path.join(SAMPLE, 'topology.json'));
/** The sample repo's cloud registry */
export const sampleRegistry = () => readJson(path.join(SAMPLE, 'topology.cloud.json'));
/** The sample repo's personas file */
export const samplePersonas = () => readJson(path.join(SAMPLE, 'topology.personas.json'));
/** A house answer as a source gives it (the sample's house file, with its time) */
export const recordedHouse = () => ({ ok: true, data: { at: '2026-10-11T18:00:00.000Z', ...readJson(path.join(SAMPLE, 'cornfield.house.json')) } });
/** The explorer page as the server serves it, before the import map goes in */
export const explorerPage = () => fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');

/** A port nothing listens on right now */
export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A two-floor plan (Main Floor over Basement) the House tests fall back to, like a repo's own house source would */
export const TEST_PLAN = Object.freeze({
  viewBox: { width: 800, height: 600 },
  floors: [{ id: 'basement', name: 'Basement', level: -1 }, { id: 'main', name: 'Main Floor', level: 0 }],
  rooms: [
    { id: 'kitchen', floor_id: 'main', name: 'Kitchen', x: 510, y: 190, w: 137, h: 110 },
    { id: 'living-room', floor_id: 'main', name: 'Living room', x: 60, y: 60, w: 300, h: 220 },
    { id: 'basement', floor_id: 'basement', name: 'Basement', x: 40, y: 40, w: 500, h: 400 },
  ],
});

/** The floor hook a repo's house source gives: the plain renderer over TEST_PLAN, with an editor link per floor */
export async function testFloorHook() {
  const { createFloorRenderer } = await import('../plugins/house/browser.js');
  return createFloorRenderer({ plan: TEST_PLAN, editUrl: (f) => (f ? `https://plan.example.test/house?floor=${encodeURIComponent(f)}` : 'https://plan.example.test/house') });
}
