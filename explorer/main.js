/**
 * @module explorer/main
 *
 * The topology explorer's entry point (explorer/index.html loads only this module). cornfield's own page is explorer/page.js: it makes
 * the one instance of the engine for the document and starts everything (spec 0011 D2).
 */

import { startPage } from './page.js';

startPage();
