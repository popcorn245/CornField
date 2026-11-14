/**
 * @module explorer/pieces/work-issues
 *
 * The Issues tab (its rows are drawn with the PRs' in work-prs.js), an issue's actions in the node panel, and an issue older than the Work view's 14 days.
 * Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { issueUrl, listUrl, listKeyOf, specBlock } from '../forge-panel-model.js';

export function install(ctx) {
  const { ui, fn } = ctx;
  const { t } = ctx.h;

  /** An issue's actions in the node panel: Start a spec (step 1 of the pipeline) and Start an agent, each opening its confirm step; a closed issue has none */
  function issueActionsHtml(item) {
    const n = item.number;
    if (!item.open) return `<p class="hx-faint">${escHtml(specBlock({ state: 'closed' }))}</p>`;
    const spec = specBlock({ state: 'open' }) === null
      ? `<button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act hx-forge-startspec" data-forge-spec="${n}" aria-label="Start a spec for issue ${n}"${ui.busy ? ' disabled' : ''}>Start a spec …</button>`
      : '';
    const agent = `<button data-corn-kind="secondary" type="button" class="hx-btn hx-forge-act hx-forge-startspec" data-forge-agent="issue:${n}" aria-label="${escHtml(t('startAgent'))} on issue ${n}">${escHtml(t('startAgent'))} …</button>`;
    return `<div class="hx-forge-cta">${agent}${spec}</div>`;
  }

  /**
   * The issue the Work list names that the graph does not draw: a list already read holds it (the open one is read for this), else the issue's own route does (a closed one, or one past the end of the list).
   * `null` says why in the list and through the live region when there is none.
   */
  async function oldIssue(n) {
    const key = listKeyOf('issues', 'open');
    if (!ui.lists[key]) {
      const res = await fn.request(listUrl('issues', 'open'), false);
      if (res.ok && !ui.lists[key]) ui.lists[key] = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
    }
    const hit = Object.entries(ui.lists).filter(([k]) => k.startsWith('issues|')).flatMap(([, list]) => list.items).find((i) => i.number === n); // any list read, whatever its state filter
    if (hit) return hit;
    const res = await fn.request(issueUrl(n));
    if (res.ok && res.body.issue) return res.body.issue;
    fn.linkMissing(res.status === 404 ? `There is no issue ${n}.` : fn.failWords(res, `issue ${n}`));
    return null;
  }

  Object.assign(fn, { issueActionsHtml, oldIssue });
}
