/**
 * @vitest-environment node
 *
 * The forge half of the release notes (server/release-notes.js), for both forges, against a fake forge on loopback that
 * serves the recorded answers of test/fixtures/forge/notes-github.json and notes-forgejo.json: the same world (tags
 * v0.1.0, nightly and v0.2.0; pull requests 20 to 23 merged after v0.2.0, 19 before it, 24 never landed) on the sample
 * repo's map. Nothing is written to the forge, and no network is touched.
 */
import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { createForge, ForgeError } from '../../server/forge.js';
// @ts-expect-error plain JS modules, no declarations
import { mergedSince, releaseNotes, MAX_PULLS } from '../../server/release-notes.js';
import { loadSample } from '../helpers.js';
import { fakeForge, recordings } from './fake-forge.js';

const FORGES = [
  { type: 'github', pull: 'https://github.example.com/owner/name/pull' },
  { type: 'forgejo', pull: 'https://forgejo.example.com/owner/name/pulls' },
];

describe.each(FORGES)('the release notes on $type', ({ type, pull }) => {
  let fake;
  afterEach(async () => { await fake?.close(); fake = undefined; });
  const forgeOn = async () => {
    fake = await fakeForge(recordings(`notes-${type}`));
    return createForge({ type, url: fake.url, repo: 'owner/name' }, { token: 'test-token-not-a-secret', apiUrl: fake.url });
  };
  const sample = loadSample();

  it('reads the pull requests merged after the latest version tag, and the files of those only', async () => {
    const forge = await forgeOn();
    const found = await mergedSince(forge);
    expect(found.since).toEqual({ name: 'v0.2.0', sha: '2'.repeat(40), date: '2026-10-12T09:00:00Z' });
    // Newest merge first; 19 merged before the tag, 24 never landed, 26 landed on release/0.2, not on the default branch
    expect(found.pulls.map((p) => p.number)).toEqual([23, 22, 21, 20]);
    expect(found.branch).toBe('main');
    expect(found.pulls[1].files.map((f) => [f.path, f.status, f.previousPath])).toEqual([['packages/web/src/cart.js', 'renamed', 'packages/web/src/basket.js']]);
    expect(found.truncated).toBe(false);
    const files = fake.requests.filter((r) => /\/pulls\/\d+\/files/.test(r.url)).map((r) => Number(/pulls\/(\d+)\//.exec(r.url)[1]));
    expect(files.sort()).toEqual([20, 21, 22, 23]);
    expect(fake.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('starts from the tag it is asked for, and says so when there is no such tag', async () => {
    const forge = await forgeOn();
    const all = await mergedSince(forge, { since: 'v0.1.0' });
    expect(all.since.name).toBe('v0.1.0');
    expect(all.pulls.map((p) => p.number)).toEqual([23, 22, 21, 20, 19]);
    const missing = await mergedSince(forge, { since: 'v9.9.9' }).catch((e) => e);
    expect(missing).toBeInstanceOf(ForgeError);
    expect(missing.message).toBe('owner/name has no tag named "v9.9.9".');
    expect((await mergedSince(forge, { since: 'v0.2.0' })).pulls).toHaveLength(4);
  });

  it('groups them by the map, Breaking first, Other last, each line linking its pull request', async () => {
    const forge = await forgeOn();
    const notes = await releaseNotes(forge, { topology: sample, version: '0.3.0' });
    expect(notes).toMatchObject({ since: { name: 'v0.2.0' }, tags: ['v0.2.0', 'v0.1.0'], suggestedTag: 'v0.3.0', breakingLabel: 'breaking', count: 4, truncated: false });
    expect(notes.groups.map((g) => [g.kind, g.title, g.items.map((i) => i.number)])).toEqual([
      ['breaking', 'Breaking', [22]],
      ['area', 'web.example.test', [21]],
      ['area', 'api.example.test', [20, 21]],
      ['area', 'app-stack', [20]],
      ['other', 'Other', [23]],
    ]);
    expect(notes.markdown).toBe([
      '### Breaking', '',
      `- Rename the cart route \\[breaking\\] ([#22](${pull}/22) by @agent-four) · \`web.example.test\`, \`@acme/web\``, '',
      '### web.example.test', '',
      `- Geo search by name ([#21](${pull}/21) by @agent-four) · \`/\``, '',
      '### api.example.test', '',
      `- Orders: one endpoint, one container ([#20](${pull}/20) by @agent-five) · \`/api/v1/orders\`, \`/api/v1/webhooks/files\``,
      `- Geo search by name ([#21](${pull}/21) by @agent-four) · \`/api/v1/geo/search\`, \`geo.js\``, '',
      '### app-stack', '',
      `- Orders: one endpoint, one container ([#20](${pull}/20) by @agent-five) · \`web\`, \`api\`, \`nextcloud\`, \`homeassistant\`, and 3 more`, '',
      '### Other', '',
      `- Fix a typo in the readme ([#23](${pull}/23) by @maintainer-one)`, '',
    ].join('\n'));
  });

  it('gives the same notes for the same inputs, and another breaking label regroups', async () => {
    const forge = await forgeOn();
    const first = await releaseNotes(forge, { topology: sample });
    expect(await releaseNotes(forge, { topology: sample })).toEqual(first);
    expect(first.suggestedTag).toBe('v0.2.1');
    const none = await releaseNotes(forge, { topology: sample, breakingLabel: 'semver-major' });
    expect(none.groups.map((g) => g.kind)).not.toContain('breaking');
    expect(none.count).toBe(4);
  });
});

describe('the pull requests read for their files', () => {
  /** A forge that has `n` merged pull requests since its one tag, and counts the file listings it is asked for */
  const manyPulls = (n) => {
    const asked = [];
    return {
      asked,
      forge: {
        repo: 'owner/name',
        tags: async () => [{ name: 'v1.0.0', sha: 'a' }],
        tag: async (name) => ({ name, sha: 'a', date: '2026-01-01T00:00:00Z' }),
        defaultBranch: async () => 'main',
        pulls: async () => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, state: 'merged', labels: [], author: null, url: null, base: { ref: 'main' }, mergedAt: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() })),
        pullFiles: async (num) => { asked.push(num); return []; },
      },
    };
  };

  it('are the newest few, and says when there were more', async () => {
    const { forge, asked } = manyPulls(MAX_PULLS + 20);
    const found = await mergedSince(forge);
    expect(found.pulls).toHaveLength(MAX_PULLS);
    expect(found.truncated).toBe(true);
    expect(Math.min(...asked)).toBe(21); // the 20 oldest are left out
  });

  it('with no version tag at all, are every merged pull request', async () => {
    const { forge } = manyPulls(3);
    forge.tags = async () => [{ name: 'nightly', sha: 'a' }];
    const found = await mergedSince(forge);
    expect(found.since).toBeNull();
    expect(found.pulls).toHaveLength(3);
    expect((await releaseNotes(forge, { topology: { nodes: [], edges: [] } })).markdown).toContain('### Other');
  });
});
