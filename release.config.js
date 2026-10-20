/**
 * semantic-release's config: a release on every merge to main (.github/workflows/release.yml), its version worked out
 * from the conventional commit titles since the last tag (RELEASING.md).
 *
 * cornfield stays on 0.x: a breaking change bumps the minor version, not the major (the owner's decision), so 1.0 is a
 * release someone makes on purpose. feat is a minor release, fix and perf a patch; anything else (docs, chore, ci,
 * refactor, test…) makes no release on its own.
 *
 * What it does, in order: works out the version; writes the notes into CHANGELOG.md under [Unreleased], in the file's
 * own Keep a Changelog form; sets the version in package.json and package-lock.json (it does not publish: the
 * workflow's npm job does, behind cli/release-guard.js); commits those three files back to main with a skip-CI marker in the message (below); tags
 * v<version>; and makes the GitHub release. The image and the npm packages are published by the same workflow run,
 * from that tag.
 */

/** The top of CHANGELOG.md, kept as it is: the notes of a release go right under it, above the last release */
const CHANGELOG_TOP = [
  '# Changelog',
  '',
  'All notable changes to cornfield. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).',
  '',
  '## [Unreleased]',
].join('\n');

/** Commit types and the Keep a Changelog section each goes under; the hidden ones are left out of the notes */
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
        // "## [0.2.0] - 2026-10-20", as the releases already in CHANGELOG.md
        headerPartial: '## [{{version}}] - {{date}}\n',
        // "- **forge:** what changed (abc1234)": one line each, the scope in bold
        commitPartial: '- {{#if scope}}**{{scope}}:** {{/if}}{{#if subject}}{{subject}}{{else}}{{header}}{{/if}}{{#if shortHash}} ({{shortHash}}){{/if}}\n',
      },
    }],
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md', changelogTitle: CHANGELOG_TOP }],
    // The version in package.json and package-lock.json; publishing is the workflow's npm job (cli/release-guard.js)
    ['@semantic-release/npm', { npmPublish: false }],
    ['@semantic-release/git', {
      assets: ['CHANGELOG.md', 'package.json', 'package-lock.json'],
      message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
    }],
    // The GitHub release; no comments on pull requests or issues, so the job needs no write access to them
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
};
