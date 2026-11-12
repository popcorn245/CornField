/**
 * @module explorer/search-status
 *
 * A bridge (spec 0011 D2, step 4): the search's live region now lives in engine/search-status.js, one per instance. This file keeps the old
 * names for the page's instance. It goes when no module that is not on an instance (and no test) calls it.
 */
import { pageInstance } from './state.js';
import * as S from './engine/search-status.js';

export { NO_MATCH_DELAY_MS } from './engine/search-status.js';
export const noMatchText = (query) => S.noMatchText(pageInstance(), query);
export const showSearchStatus = (text) => S.showSearchStatus(pageInstance(), text);
export const updateSearchStatus = (query, found, count) => S.updateSearchStatus(pageInstance(), query, found, count);
