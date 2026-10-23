/**
 * semantic-release's config: a release on every merge to main (.github/workflows/release.yml), its version worked out
 * from the conventional commit titles since the last tag (RELEASING.md).
 *
 * cornfield stays on 0.x: a breaking change bumps the minor version, not the major (the owner's decision), so 1.0 is a
 * release someone makes on purpose. feat is a minor release, fix and perf a patch; anything else (docs, chore, ci,
 * refactor, test…) makes no release on its own.
 *
 * Nothing is committed back to main (it is locked): the tag is the only record of a version. semantic-release works
 * out the version, tags the merge commit itself v<version> (a tag-only push) and makes the GitHub release, which
 * carries the notes. The workflow's image and npm jobs then check that tag out and set the version in package.json
 * from it (`npm version --no-git-tag-version`) before they build and publish.
 */

/** Commit types and the Keep a Changelog section each goes under in the release's notes; the hidden ones are left out */
const TYPES = [
  { type: 'feat', section: 'Added' },
  { type: 'fix', section: 'Fixed' },
  { type: 'perf', section: 'Changed' },
  { type: 'revert', section: 'Changed' },
  { type: 'refactor', hidden: true },
  { type: 'docs', hidden: true },
  { type: 'style', hidden: true },
  { type: 'test', hidden: true },
  { type: 'build', hidden: true },
  { type: 'ci', hidden: true },
  { type: 'chore', hidden: true },
];

export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', {
      preset: 'conventionalcommits',
      // A custom rule that matches wins over the defaults, so a breaking change is minor, never major (0.x)
      releaseRules: [
        { breaking: true, release: 'minor' },
        { type: 'feat', release: 'minor' },
        { type: 'fix', release: 'patch' },
        { type: 'perf', release: 'patch' },
        { type: 'revert', release: 'patch' },
      ],
    }],
    ['@semantic-release/release-notes-generator', {
      preset: 'conventionalcommits',
      presetConfig: { types: TYPES },
      writerOpts: {
        // "## [0.2.0] - 2026-10-20", the form of the releases in CHANGELOG.md
        headerPartial: '## [{{version}}] - {{date}}\n',
        // "- **forge:** what changed (abc1234)": one line each, the scope in bold
        commitPartial: '- {{#if scope}}**{{scope}}:** {{/if}}{{#if subject}}{{subject}}{{else}}{{header}}{{/if}}{{#if shortHash}} ({{shortHash}}){{/if}}\n',
      },
    }],
    // The GitHub release, with the notes; no comments on pull requests or issues, so the job needs no write access to them
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
};
