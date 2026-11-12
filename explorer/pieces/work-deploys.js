/**
 * @module explorer/pieces/work-deploys
 *
 * The Deploys tab: the list and a deploy's detail, lit on the map. Part of the Work piece (pieces/work.js): `install(ctx)` makes this part's functions for one mount, and hands the ones other parts call
 * to `ctx.fn`; nothing is shared between two mounts.
 */

import { withParts } from '../engine/piece.js';
import { litForDeploy, nodesForRestarts, deployWords, deployMeta } from '../forge-panel-model.js';
import { cornStateAttr, markStateAttr, stateIconHtml } from '../corn-state.js';
import { layerOn } from '../layer-model.js';
import { LAYER_DEFS } from '../engine/layers.js';
import { escapeHtml as escHtml } from '../../core/text.js';
import { plural, safeUrl, backHtml } from './work-common.js';

export function install(ctx) {
  const { ui, m, fn, state, $ } = ctx;
  const { announce, render, touchScene, isNodeVisible, toggleLayer } = ctx.h;

  /** Selects a deploy: nothing to ask (the list holds what it restarted), so its nodes light at once */
  function selectDeploy(id) {
    const found = ui.lists.deploys && ui.lists.deploys.items.find((d) => d.id === id);
    if (!found) return;
    m.pullToken++;
    fn.dropThread();
    ui.selected = null;
    ui.detail = null;
    ui.detailError = '';
    ui.lit = null;
    ui.deploy = id;
    ui.deployItem = found;
    // A container, a stack or a machine is on a layer that starts off: the layers the deploy's nodes are on come on, or nothing would light
    const turnedOn = [];
    for (const n of litForDeploy(found, state.nodes).nodes) {
      const layer = LAYER_DEFS.find((l) => l.key === n.type);
      if (layer && !layerOn(state, layer.key)) { toggleLayer(layer.key); turnedOn.push(layer.label); }
    }
    fn.relight();
    $('forge-panel').querySelector('.hx-forge-body').scrollTop = 0; // the deploy's nodes are what was asked for, not the row that was tapped
    announce(deploySelectionWords(turnedOn));
  }

  /** Lets go of the selected deploy: nothing is lit any more */
  function clearDeploy() {
    const had = ui.deployItem;
    ui.deploy = null;
    ui.deployItem = null;
    ui.litDeploy = null;
    state.forgeLit = null;
    touchScene();
    render();
    fn.paint();
    if (had) announce(`Deploy ${had.name} cleared`);
  }

  /** What a deploy lights, said short, for its row: how many nodes, or that it is not mapped */
  function lightsWords(deploy) {
    if (!deploy.restarts.length) return 'Not mapped to a node';
    const { nodes } = nodesForRestarts(deploy.restarts, state.nodes);
    return nodes.length ? `Lights ${plural(nodes.length, 'node')}` : 'Names nodes not on the map';
  }

  function deployHtml(d) {
    const link = safeUrl(d.url);
    const out = link ? `<a data-corn="out-link" class="hx-forge-out" href="${escHtml(link)}" target="_blank" rel="noreferrer" aria-label="Open deploy ${escHtml(d.name)} on ${escHtml(fn.forgeName())} (new tab)">↗</a>` : '';
    return `<li class="hx-forge-item"><button type="button" class="hx-forge-row" data-forge-deploy="${escHtml(d.id)}" aria-pressed="${ui.deploy === d.id}" data-corn="row">
      <span class="hx-forge-title">${escHtml(d.name)}${d.title && d.title !== d.name ? `<span class="hx-faint"> · ${escHtml(d.title)}</span>` : ''}</span>
      <span class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}" data-corn="state-pill"${cornStateAttr(d.state)}>${stateIconHtml(d.state)}${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, m.now()))}</span>
      <span class="hx-forge-labels"><span class="hx-forge-label" data-corn="tag">${escHtml(lightsWords(d))}</span></span></button>${out}</li>`;
  }

  /** The selected deploy: what it was, and the nodes it restarted (each a button that selects it on the map) */
  function deployDetailHtml() {
    const d = ui.deployItem;
    const lit = ui.litDeploy;
    const url = safeUrl(d.url);
    const head = `${backHtml('clear-forge-deploy', 'All deploys')}<h3 class="hx-forge-detail-title" data-corn="detail-title">${escHtml(d.name)}</h3>
      <p class="hx-forge-meta"><span class="hx-forge-state hx-forge-state--${escHtml(d.state)}" data-corn="state-pill"${cornStateAttr(d.state)}>${stateIconHtml(d.state)}${escHtml(deployWords(d))}</span> ${escHtml(deployMeta(d, m.now()))}${url ? ` · <a data-corn="text-link" class="hx-link" href="${escHtml(url)}" target="_blank" rel="noreferrer">Open on ${escHtml(fn.forgeName())} ↗</a>` : ''}</p>`;
    const stale = ui.lists.deploys && ui.lists.deploys.stale;
    let body;
    if (!d.restarts.length) {
      body = '<p class="hx-forge-notice" data-corn="notice">No node is mapped to this deploy, so nothing is lit. Say what it restarts under <code class="hx-code">deploys.restarts</code> in cornfield.config.js (docs/deploys.md).</p>';
    } else {
      const rows = lit.nodes.map((n) => `<li class="hx-forge-file" data-corn="file"><button data-corn="node-chip" type="button" class="hx-forge-node" data-forge-node="${escHtml(n.id)}" aria-label="Show ${escHtml(n.label)} on the map${isNodeVisible(n) ? '' : ' (its layer is off)'}">${escHtml(n.label)}${isNodeVisible(n) ? '' : ' · layer off'}</button> <span class="hx-faint">${escHtml(n.type)}</span></li>`).join('');
      const missing = lit.missing.length ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(lit.missing.join(', '))} ${lit.missing.length === 1 ? 'is' : 'are'} named in the config but not on the map.</p>` : '';
      const key = lit.nodes.length ? `<p class="hx-forge-key hx-faint"><span class="hx-mark-dot hx-mark-dot--${d.state === 'failure' ? 'removed' : 'changed'}" data-corn="mark-dot"${markStateAttr(d.state === 'failure' ? 'removed' : 'changed')} aria-hidden="true"></span>${d.state === 'failure' ? 'restarted by a deploy that failed' : 'restarted by this deploy'}</p>` : '';
      body = `<h4 class="hx-forge-sub">${escHtml(`Restarted: ${plural(lit.nodes.length, 'node')} on the map`)}</h4>${key}${rows ? `<ul class="hx-forge-files">${rows}</ul>` : ''}${missing}`;
    }
    return `${head}${stale ? `<p class="hx-forge-notice" data-corn="notice">${escHtml(`This is an older answer. ${stale}`)}</p>` : ''}${body}`;
  }

  /** What a screen reader hears when a deploy is selected */
  function deploySelectionWords(turnedOn = []) {
    const { name, branch } = ui.deployItem;
    const lit = ui.litDeploy;
    const head = `Deploy ${name}${branch ? ` of ${branch}` : ''}, ${deployWords(ui.deployItem).toLowerCase()}`;
    if (!ui.deployItem.restarts.length) return `${head}. No node is mapped to it, so nothing is lit.`;
    const layers = turnedOn.length ? ` Turned on the ${turnedOn.join(' and ')} ${turnedOn.length === 1 ? 'layer' : 'layers'}.` : '';
    return `${head}: ${plural(lit.nodes.length, 'node')} restarted and lit${lit.missing.length ? `, ${lit.missing.length} named that ${lit.missing.length === 1 ? 'is' : 'are'} not on the map` : ''}.${layers}`;
  }

  // what other parts put in the panel gets its parts (a hook is a part of the same name)
  Object.assign(fn, { selectDeploy, clearDeploy, lightsWords, deployHtml: (...a) => withParts(deployHtml(...a)), deployDetailHtml: (...a) => withParts(deployDetailHtml(...a)), deploySelectionWords });
}
