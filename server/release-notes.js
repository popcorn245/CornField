/**
 * @module server/release-notes
 *
 * The forge half of the release notes (PIPE-04; the drafting itself is core/release-notes.js): which pull requests
 * were merged since a tag, and the notes for them. It only reads: the tags, the closed pull requests and the files of
 * each one that landed (server/forge.js). The routes (server/forge-routes.js) and `cornfield notes` both call it.
 *
 * "Since a tag" is the pull requests merged after the commit the tag names was made. The tag is the one asked for, else
 * the highest version tag; with no version tag yet, every merged pull request the listing reaches. At most
 * `LOOKBACK` closed pull requests are looked through, and of the merged ones at most `MAX_PULLS` (the newest) are read
 * for their files: `truncated` says when there were more.
 */

import { ForgeError } from './forge.js';
import { DEFAULT_BREAKING_LABEL, compareTags, draftNotes, latestTag, parseTag, renderMarkdown, suggestTag } from '../core/release-notes.js';

/** The most closed pull requests looked through, and the most merged ones whose files are read */
export const LOOKBACK = 300;
export const MAX_PULLS = 100;
/** The tags offered to start from in the explorer */
export const MAX_TAG_CHOICES = 30;
const FILES_AT_ONCE = 5;

/**
 * The merged pull requests since a tag, each with its files.
 * @param {import('./forge.js').Forge} forge
 * @param {{ since?: string | null }} [opts] a tag's name; the latest version tag when omitted
 * @returns {Promise<{ tags: import('./forge.js').Tag[], since: import('./forge.js').TagInfo | null, pulls: (import('./forge.js').Pull & { files: import('./forge.js').PullFile[] })[], truncated: boolean }>}
 */
export async function mergedSince(forge, { since = null } = {}) {
  const tags = await forge.tags();
  const start = since ? tags.find((t) => t.name === since) : latestTag(tags);
  if (since && !start) throw new ForgeError(`${forge.repo} has no tag named ${JSON.stringify(since)}.`, { code: 'not-found' });
  const base = start ? await forge.tag(start.name) : null;
  const after = base ? Date.parse(base.date) : -Infinity;
  const closed = await forge.pulls({ state: 'closed', limit: LOOKBACK });
  const merged = closed
    .filter((p) => p.state === 'merged' && p.mergedAt && Date.parse(p.mergedAt) > after)
    .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)) || b.number - a.number);
  const picked = merged.slice(0, MAX_PULLS);
  const pulls = [];
  for (let i = 0; i < picked.length; i += FILES_AT_ONCE) {
    const files = await Promise.all(picked.slice(i, i + FILES_AT_ONCE).map((p) => forge.pullFiles(p.number)));
    files.forEach((f, j) => pulls.push({ ...picked[i + j], files: f }));
  }
  return { tags, since: base, pulls, truncated: merged.length > picked.length };
}

/**
 * The notes since a tag: the groups, the Markdown, and what the explorer shows around them.
 * @param {import('./forge.js').Forge} forge
 * @param {{ topology: { nodes: any[], edges?: any[] } | null, since?: string | null, breakingLabel?: string, version?: string | null }} opts
 *   `version` is the package's, for the name suggested for the draft
 */
export async function releaseNotes(forge, { topology, since = null, breakingLabel = DEFAULT_BREAKING_LABEL, version = null }) {
  const found = await mergedSince(forge, { since });
  const notes = draftNotes({ pulls: found.pulls, topology, breakingLabel });
  const choices = found.tags.filter((t) => parseTag(t.name)).sort((a, b) => compareTags(b.name, a.name)).slice(0, MAX_TAG_CHOICES).map((t) => t.name);
  return {
    since: found.since ? { name: found.since.name, date: found.since.date } : null,
    tags: choices,
    suggestedTag: suggestTag(found.tags, version),
    breakingLabel,
    count: notes.count,
    truncated: found.truncated,
    groups: notes.groups,
    markdown: renderMarkdown(notes, { since: found.since ? found.since.name : null }),
  };
}
