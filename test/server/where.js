import path from 'node:path';

/** What the proposal routes are told about a repo in a test: the defaults, with the data folder inside the temporary root */
export const whereOf = (root) => ({
  root,
  proposals: 'docs/specs/proposals',
  worktrees: '.claude/worktrees',
  topology: 'topology.json',
  dataDir: path.join(root, '.cornfield-data'),
});
