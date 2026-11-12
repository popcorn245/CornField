/**
 * @module explorer/feedback
 *
 * A bridge (spec 0011 D2, step 4): the results of actions now live on the instance (engine/feedback.js). This file keeps the old names for the
 * modules that are not yet on an instance (forge-panel.js), bound to the page's instance. It goes when forge-panel.js is converted.
 */
import { pageInstance } from './state.js';
import * as F from './engine/feedback.js';

export { RESULT_MS } from './engine/feedback.js';
export const sayResult = (key, text, ok = true) => F.sayResult(pageInstance(), key, text, ok);
export const resultOf = (key) => F.resultOf(pageInstance(), key);
export const clearResult = (key) => F.clearResult(pageInstance(), key);
export const showResultIn = (el, key) => F.showResultIn(pageInstance(), el, key);
export const resetFeedbackForTests = () => F.resetFeedback(pageInstance());
