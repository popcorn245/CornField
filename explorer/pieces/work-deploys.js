/**
 * @module explorer/pieces/work-deploys
 *
 * The Deploys tab: the list, and a deploy's detail in the node panel (what it restarted, its logs on the forge). Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { withParts } from '../engine/piece.js';
import { nodesForRestarts, deployWords, deployMeta, listUrl } from '../forge-panel-model.js';
import { cornStateAttr, stateIconHtml } from '../corn-state.js';
import { escapeHtml as escHtml } from '../../core/text.js';
import { plural, safeUrl } from './work-common.js';

export function install(ctx) {
  const { ui, m, fn, state } = ctx;
  const { announce, isNodeVisible } = ctx.h;

  /** Shows a deploy in the node panel: nothing to ask once the list is read (it holds what the deploy restarted) */
  function selectDeploy(id) {
    const found = ui.lists.deploys && ui.lists.deploys.items.find((d) => d.id === id);
    if (!found) return false;
    m.pullToken++;
    fn.dropThread();
    ui.selected = null;
    ui.detail = null;
    ui.detailError = '';
    ui.lit = null;
    ui.deploy = id;
    ui.deployItem = found;
    fn.figure();
    fn.sayDetail(deploySelectionWords());
    return true;
  }

  /** The deploys list is read once for a deploy the node panel shows (the graph does not hold what a deploy restarted); a deploy older than the last hundred is said, never blank */
  async function showDeploy(id) {
    if (!ui.lists.deploys) {
      const res = await fn.request(listUrl('deploys', 'all'), false);
      if (res.ok) ui.lists.deploys = { items: res.body.items || [], at: res.body.at, rate: res.body.rate || '', stale: res.body.stale || '', problem: res.body.problem || '' };
    }
    if (ui.node === '') return; // the panel moved on while the list was read
    if (!selectDeploy(id)) {
      ui.deploy = null;
      ui.deployItem = null;
      ui.detailError = ui.lists.deploys ? 'This deploy is older than the last hundred the forge was asked for, so what it restarted is not known here.' : 'The deploys could not be read.';
      fn.paint();
    }
  }

  /** Lets go of the deploy in the node panel */
  function clearDeploy() {
    ui.deploy = null;
    ui.deployItem = null;
    ui.litDeploy = null;
  }

  /** What a deploy restarts, said short, for its row: how many nodes, or that it is not mapped */
  function restartWords(deploy) {
    if (!deploy.restarts.length) return 'Not mapped to a node';
    const { nodes } = nodesForRestarts(deploy.restarts, state.nodes);
    return nodes.length ? `Restarts ${plural(nodes.length, 'node')}` : 'Names nodes not on the map';
  }

  function deployHtml(d) {
    const link = safeUrl(d.url);
    const out = link ? `<a data-corn="out-link" class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open deploy ${escHtml(d.name)} on ${escHtml(fn.forgeName())} (new tab)">↗</a>` : '';
    return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-work-ref="deploy:${escHtml(d.id)}" aria-pressed="${fn.isShown(`deploy:${d.id}`)}" data-corn="row">
      <span class="hx-forge-title">${escHtml(d.name)}${d.title && d.title !== d.name ? `<span class="hx-faint"> · ${escHtml(d.title)}</span>` : ''}</span>
      <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}" data-corn="state-pill"${cornStateAttr(d.state)}>${stateIconHtml(d.state)}${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, m.now()))}</span>
      <span class="hx-forge-labels"><span class="hx-forge-label" data-corn="tag">${escHtml(restartWords(d))}</span></span></button>${out}</li>`;
  }

  /** The deploy in the node panel: what it was, its logs on the forge, and the nodes it restarted (each a button that selects it on the map) */
  function deployDetailHtml() {
    if (ui.detailError && !ui.deployItem) return `<p class="hx-forge-notice" data-corn="notice">${escHtml(ui.detailError)}</p>`;
    const d = ui.deployItem;
    if (!d) return '<p class="hx-faint">Loading what it restarted …</p>';
    const lit = ui.litDeploy;
    const url = safeUrl(d.url);
    const head = `<p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}" data-corn="state-pill"${cornStateAttr(d.state)}>${stateIconHtml(d.state)}${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, m.now()))}</p>
      ${url ? `<div class="hx-forge-cta"><a data-corn="open-link" data-corn-kind="secondary" class="hx-btn hx-forge-open" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open the logs on ${escHtml(fn.forgeName())} ↗</a></div>` : ''}`;
    const stale = ui.lists.deploys && ui.lists.deploys.stale;
    let body;
    if (!d.restarts.length) {
      body = '<p class="hx-forge-notice" data-corn="notice">No node is mapped to this deploy. Say what it restarts under <code class="hx-code">deploys.restarts</code> in cornfield.config.js (docs/deploys.md).</p>';
    } else {
      const rows = lit.nodes.map((n) => `<li class="hx-forge-file" data-corn="file"><button data-corn="node-chip" type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button> <span class="hx-faint">${escHtml(n.type)}</span></li>`).join('');
      const missing = lit.missing.length ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(lit.missing.join(', '))} ${lit.missing.length === 1 ? 'is' : 'are'} named in the config but not on the map.</p>` : '';
      body = `<h3 class="hx-forge-sub">${escHtml(`Restarted: ${plural(lit.nodes.length, 'node')} on the map`)}</h3>${rows ? `<ul class="hx-forge-files">${rows}</ul>` : ''}${missing}`;
    }
    return `${head}${stale ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}${body}`;
  }

  /** What a screen reader hears when a deploy is selected */
  function deploySelectionWords() {
    const { name, branch } = ui.deployItem;
    const lit = ui.litDeploy;
    const head = `Deploy ${name}${branch ? ` of ${branch}` : ''}, ${deployWords(ui.deployItem).toLowerCase()}`;
    if (!ui.deployItem.restarts.length) return `${head}. No node is mapped to it.`;
    return `${head}: ${plural(lit.nodes.length, 'node')} restarted on the map${lit.missing.length ? `, ${lit.missing.length} named that ${lit.missing.length === 1 ? 'is' : 'are'} not on the map` : ''}.`;
  }

  // what other parts put in the panel gets its parts (a hook is a part of the same name)
  Object.assign(fn, { selectDeploy, showDeploy, clearDeploy, restartWords, deployHtml: (...a) => withParts(deployHtml(...a)), deployDetailHtml: (...a) => withParts(deployDetailHtml(...a)), deploySelectionWords });
}
