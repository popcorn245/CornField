/**
 * @module server/defuse
 *
 * Moved to core/defuse.js, so core/ (core/agent-contract.js) can use it without importing server code. Re-exported here so
 * the server's imports keep working.
 */
export { ZW, defuse } from '../core/defuse.js';
