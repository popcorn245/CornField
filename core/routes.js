/**
 * @module core/routes
 *
 * The routes cornfield answers under /proposals (spec 0012 B2, B5), written down once as data so
 * the map can be derived from them (core/routes.js instead of being typed in by
 * hand. No imports: the CLI reads this file as well as the server.
 *
 * proposals.js is what answers the requests; test/server/routes.test.js keeps this table honest against it (every
 * method listed here is answered, anything else gets a 405 whose `Allow` is these methods). Change a
 * route there, change it here, and run `cornfield sync`.
 *
 * `reads` and `writes` say what the route does with the proposal files on disk (docs/specs/proposals/):
 * the dependency keys it reads and the label of what it writes. They become the map's edges between the
 * "Proposal files" store and the route.
 */

/** Where the proposal files live, relative to a checkout (or to a worktree under .claude/worktrees/) */
export const PROPOSAL_FILES_DIR = 'docs/specs/proposals';

/**
 * @typedef {object} HubRoute
 * @property {string} route    the path, `[slug]` standing for the proposal's name
 * @property {string[]} methods  every method the route accepts (HEAD answers wherever GET does and is left out)
 * @property {{ keys: string[], label: string }} reads  what a read of the route looks at in the proposal files
 * @property {{ label: string }} [writes]  what the route writes there, when it writes
 */

/** @type {HubRoute[]} */
export const PROPOSAL_ROUTES = [
  {
    route: '/proposals',
    methods: ['GET'],
    reads: { keys: [`${PROPOSAL_FILES_DIR}/*.json`], label: 'lists every proposal file' },
  },
  {
    route: '/proposals/[slug].json',
    methods: ['GET'],
    reads: { keys: [`${PROPOSAL_FILES_DIR}/<slug>.json`], label: 'serves one proposal, read-only' },
  },
  {
    route: '/proposals/[slug]/review',
    methods: ['GET', 'PUT'],
    reads: { keys: [`${PROPOSAL_FILES_DIR}/<slug>.review.json`], label: 'GET: the last review' },
    writes: { label: 'PUT: writes <slug>.review.json beside the proposal' },
  },
];
