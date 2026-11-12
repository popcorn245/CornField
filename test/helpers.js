/**
 * What the tests share: the sample repo (test/fixtures/sample, a small self-hosted repo with packages, one
 * stack on one machine, personas, a cloud registry, a house file and a proposal) and readers for it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withParts } from '../explorer/engine/piece.js';
import { markup as nodePanelMarkup } from '../explorer/pieces/node-panel.js';
import { markup as layersMarkup } from '../explorer/pieces/layers.js';
import { markup as searchMarkup } from '../explorer/pieces/search.js';
import { markup as mapMarkup, KEYS_HELP_WITH_PANEL } from '../explorer/pieces/map.js';

import { markup as proposalMarkup } from '../explorer/pieces/proposal.js';
import { markup as changesMarkup } from '../explorer/pieces/changes.js';
import { markup as decisionMarkup } from '../explorer/pieces/decision.js';
import { markup as workMarkup } from '../explorer/pieces/work-markup.js';

const PIECE_MARKUP = {
  'node-panel': nodePanelMarkup, layers: layersMarkup, search: searchMarkup, map: () => mapMarkup({ keysHelp: KEYS_HELP_WITH_PANEL }),
  proposal: proposalMarkup, changes: changesMarkup, decision: decisionMarkup, work: workMarkup,
};

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
/**
 * explorer/index.html. The pieces (explorer/pieces/) keep only their places in it, a `<!--corn-piece:NAME/SLOT-->` comment each. A test that mounts
 * them (the node panel, Layers and search through the bridges: panels.js, layers.js, search.js; the map through page.js) wants the page as it is.
 * A test that reads the markup itself, or drives a module on markup that page.js would have mounted, names the pieces whose markup it wants in
 * place (`{ pieces: ['map'] }`: the map's canvases, its keys' help and its announcer), or all of them (`{ pieces: true }`), as the page shows it
 * once page.js has mounted them, parts included.
 * @param {{ pieces?: boolean | string[] }} [opts]
 */
export function explorerPage({ pieces = false } = {}) {
  const page = fs.readFileSync(path.join(EXPLORER, 'index.html'), 'utf8');
  if (!pieces) return page;
  const wanted = (name) => pieces === true || pieces.includes(name);
  let out = page.replace(/<!--corn-placeholder:([a-z-]+)\/([a-z]+)-->[\s\S]*?(?=<!--corn-piece:\1\/\2-->)/g, (all, name) => (wanted(name) ? '' : all)); // the stand-in goes when the piece comes (engine/piece.js place)
  // a piece's markup may keep a place for another (the review column holds the decision's foot): fill those too
  for (let i = 0; i < 3; i++) out = out.replace(/<!--corn-piece:([a-z-]+)\/([a-z]+)-->/g, (all, name, slot) => (wanted(name) ? withParts(PIECE_MARKUP[name]()[slot]) : all));
  return out;
}

/** The stand-in index.html keeps for a piece's markup until the piece is mounted: the same markup, with its parts, without ids (nor what points at them) */
export const standIn = (html) => withParts(html).replace(/ (?:id|aria-controls)="[^"]*"/g, '');
/** The stand-ins of explorer/index.html, by `NAME/SLOT`: the markup between `<!--corn-placeholder:NAME/SLOT-->` and the piece's marker */
export const standInsOf = (page) => Object.fromEntries([...page.matchAll(/<!--corn-placeholder:([a-z-]+\/[a-z]+)-->([\s\S]*?)<!--corn-piece:\1-->/g)].map((m) => [m[1], m[2]]));
export { PIECE_MARKUP };

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
