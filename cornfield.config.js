/**
 * cornfield's own config: cornfield maps itself (it dogfoods its own map and its own proposals).
 * Every key is documented in core/config.js and docs/config.md.
 */
export default {
  title: 'cornfield',
  derivers: [
    // Each top-level folder is a package, each source file a module, and the lines between them are imports
    { use: 'starter', options: { packages: ['cli', 'core', 'server', 'explorer', 'plugins/*'], modules: true } },
    // The docs as an app with a page each, and their links: to each other and to the modules they describe (the site: cornfield docs)
    { use: 'docs', options: { paths: ['README.md', 'CONTRIBUTING.md', 'RELEASING.md', 'CHANGELOG.md', 'docs'] } },
    'personas',
    // The outside services the code and CI reach, from topology.cloud.json
    { use: 'cloud', options: { code: ['cli', 'core', 'server', 'explorer', 'plugins'] } },
  ],
  forge: { type: 'github', url: 'https://github.com', repo: 'popcorn245/cornfield' },
  port: 3350,
  // Work on a claude/ branch is an agent's (docs/agents.md)
  agents: { branchPrefixes: ['claude/'] },
  worktrees: '.claude/worktrees',
  proposals: 'docs/specs/proposals',
  links: [{ label: 'GitHub', href: 'https://github.com/popcorn245/cornfield' }],
};
