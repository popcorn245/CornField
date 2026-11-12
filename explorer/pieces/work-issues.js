/**
 * @module explorer/pieces/work-issues
 *
 * The Issues tab and the deep link to an issue (its rows are drawn with the PRs' in work-prs.js). Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { issueUrl } from '../forge-panel-model.js';

export function install(ctx) {
  const { ui, fn, $ } = ctx;
  const { announce } = ctx.h;

  /** An issue the open list does not hold: asked for once, directly, so a closed one is called closed and a missing one missing */
  async function issueNotListed(n) {
    const res = await fn.request(issueUrl(n));
    if (res.ok && res.body.issue) {
      const { issue } = res.body;
      ui.actNote = { ok: false, text: issue.state === 'closed' ? `Issue ${n} is closed: ${issue.title}` : `Issue ${n} is open, but not in the list shown here: ${issue.title}`, url: issue.url };
      fn.paint();
      announce(ui.actNote.text);
      return false;
    }
    return fn.linkMissing(res.status === 404 ? `There is no issue ${n}.` : fn.failWords(res, `issue ${n}`));
  }

  /** `?issue=<n>`: the Issues tab with that issue's Start an agent button in view and focused, ready to press */
  async function openIssueLink(n) {
    if (!ui.config) return false;
    await fn.openTab('issues');
    const list = fn.current();
    if (!list) return fn.linkMissing(ui.error || 'The issues could not be read.');
    const item = list.items.find((i) => i.number === n);
    if (!item) return issueNotListed(n);
    fn.paint();
    const start = $('forge-list').querySelector(`[data-forge-agent="issue:${n}"]`);
    fn.bringIntoView(start);
    announce(`Issue ${n}: ${item.title}. Start an agent is ready`);
    return true;
  }

  Object.assign(fn, { issueNotListed, openIssueLink });
}
