/**
 * @module explorer/panels
 *
 * The side panel that opens when a node is selected: what the node is, and what the map knows about its data: the flows it is on, the
 * tables a page reads and writes, the services behind an endpoint, the stack an app runs on, and for a
 * cloud node (spec 0031) its plan, what breaks if it is down and who uses it, by when (cloud-model.js).
 */

import { state, nodeById, nameOf, escHtml, touchScene } from './state.js';
import { render } from './render.js';
import { FLOW_STYLES, flowSummary } from './flows.js';
import { clearScenario } from './scenario-ui.js';
import { proposalPanelHtml } from './proposal-model.js';
import { collapseSheet } from './sheets.js';
import { liveSection, hydrateLivePhotos } from './live.js';
import { cloudPanelHtml } from './cloud-model.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
//  Small HTML pieces shared by the sections below
// ---------------------------------------------------------------------------
const code = (s) => `<code class="hx-code">${escHtml(s)}</code>`;
const nm = (id) => `<span class="hx-name">${escHtml(nameOf(id))}</span>`;
const line = (color, arrow, body) => `<div class="hx-line"><span style="color:${color}">${arrow}</span><span>${body}</span></div>`;
const section = (title, rows) => (rows.length ? `<div class="hx-sec"><strong class="hx-strong">${title}</strong>${rows.join('')}</div>` : '');
const varList = (vars) => `<div class="hx-chips">${vars.map((v) => `<code class="hx-var">${escHtml(v)}</code>`).join('')}</div>`;
const edgesOf = (kind, side, id) => state.edges.filter((e) => e.kind === kind && e[side] === id);

/** Table <-> page data: which keys a page's render reads, which forms write, what ROM re-bakes */
function dataSummary(node) {
  const reads = state.edges.filter((e) => e.kind === 'reads');
  const writes = state.edges.filter((e) => e.kind === 'writes');
  const usesOut = state.edges.filter((e) => e.kind === 'uses' && e.from === node.id);
  const extendsOut = state.edges.filter((e) => e.kind === 'extends' && e.from === node.id);
  const common = section('Extends:', extendsOut.map((e) => line(FLOW_STYLES.extends.color, '↑', nm(e.to))))
    + section('Uses design tokens:', usesOut.map((e) => line(FLOW_STYLES.uses.color, '→', `${nm(e.to)} · ${e.vars.length}${varList(e.vars)}`)))
    + (node.type !== 'token' && node.vars ? section(`Defines ${node.vars.length} CSS variable(s):`, [varList(node.vars)]) : '');

  if (node.type === 'app') {
    const served = node.deployed
      ? line('#93c5fd', '⇢', `<a class="hx-link" href="${escHtml(node.url)}" target="_blank" rel="noreferrer">${escHtml(node.url)}</a> → ${(node.upstreams || []).map(code).join(' ')}${node.stack ? ` <span class="hx-faint">[${escHtml(node.stack)}]</span>` : ''}`)
      : line('#f87171', '✕', 'Not deployed by any stack in this repo');
    const runsOn = state.edges.filter((e) => e.kind === 'runs-on' && e.from === node.id)
      .map((e) => line(FLOW_STYLES['runs-on'].color, '⇢', `${nm(e.to)}${(e.mappings || []).map((m) => `<div class="hx-faint">${code(m.host)} → ${code(m.upstream)}${m.service ? ` = ${code(m.service)}` : ''}</div>`).join('')}`));
    return section('Served:', [served])
      + section('Runs on:', runsOn)
      + section('Loaded by the server per request:', reads.filter((e) => e.to === node.id).map((e) => line(FLOW_STYLES.reads.color, '←', nm(e.from))))
      + common;
  }
  if (node.type === 'token') {
    const users = state.edges.filter((e) => e.kind === 'uses' && e.to === node.id);
    return section(`${node.vars.length} variable(s):`, [varList(node.vars)])
      + section('Used by:', users.map((e) => line(FLOW_STYLES.uses.color, '←', `${nm(e.from)} · ${escHtml(e.vars.join(' '))}`)));
  }
  if (['atom', 'molecule', 'core'].includes(node.type)) {
    const pages = state.edges.filter((e) => e.dashed && e.to === node.id).map((e) => line('#818cf8', '←', nm(e.from)));
    return (node.table ? section('Record of:', [line(FLOW_STYLES.reads.color, '◆', `${escHtml(node.model)} · table ${code(node.table)}`)]) : '')
      + section('Rendered by:', pages) + common;
  }
  if (node.type === 'stack') {
    const served = state.edges.filter((e) => e.kind === 'runs-on' && e.to === node.id);
    return section('Domains served (Caddyfile → service):', served.flatMap((e) => (e.mappings || []).map((m) => line(FLOW_STYLES['runs-on'].color, '←', `<span class="hx-name">${escHtml(m.host)}</span> → ${code(m.upstream)}${m.service ? ` = ${code(m.service)}` : ''}`))))
      + section(`${(node.services || []).length} service(s):`, (node.services || []).map((s) => line('#a8a29e', '▣', `<span class="hx-name">${escHtml(s.name)}</span>${s.image ? ` <span class="hx-faint">${escHtml(s.image)}</span>` : ''}${s.ports.length ? `<div>${s.ports.map(code).join(' ')}</div>` : ''}${s.volumes.length ? `<div class="hx-faint">${s.volumes.map(escHtml).join('<br>')}</div>` : ''}`)))
      + section('Compose file:', [line('#93c5fd', '📄', code(node.file))]);
  }
  if (node.type === 'table') {
    const readers = reads.filter((e) => e.from === node.id);
    const writers = writes.filter((e) => e.to === node.id);
    const baked = readers.filter((e) => (nodeById(e.to) || {}).render?.rom === 'bake');
    return (node.model ? section('Model:', [line(FLOW_STYLES.reads.color, '◆', escHtml(node.model))]) : '')
      + section('Read by:', readers.map((e) => line(FLOW_STYLES.reads.color, '→', `${nm(e.to)} · ${e.keys.map(code).join(' ')}`)))
      + section('Written by:', writers.map((e) => line(FLOW_STYLES.writes.color, '←', `${nm(e.from)} · ${escHtml(e.label)}`)))
      + (baked.length ? section('Baked pages:', [line(FLOW_STYLES.rom.color, '♻', `a write here re-bakes <span class="hx-rom hx-bold">${baked.length}</span> file(s): ${baked.map((e) => escHtml(nameOf(e.to))).join(', ')}`)]) : '');
  }
  if (node.type === 'service') {
    const row = (e, side) => `${nm(e[side])}${e.label && e.label !== 'imports' ? ` · ${escHtml(e.label)}` : ''}`;
    return section('Kind:', [line(FLOW_STYLES.triggers.color, '◆', `${code(node.kind)}${node.summary ? `<div class="hx-faint">${escHtml(node.summary)}</div>` : ''}`)])
      + section('Started by:', [...(node.triggers || []).map((t) => line(FLOW_STYLES.triggers.color, '⏱', escHtml(t))), ...edgesOf('triggers', 'to', node.id).map((e) => line(FLOW_STYLES.triggers.color, '←', row(e, 'from')))])
      + section('Jobs:', (node.jobs || []).map((j) => line(FLOW_STYLES.triggers.color, '↻', `${code(j.name)} · cron ${code(j.cron)}`)))
      + section('Runs:', edgesOf('triggers', 'from', node.id).map((e) => line(FLOW_STYLES.triggers.color, '→', row(e, 'to'))))
      + section('Calls:', edgesOf('calls', 'from', node.id).map((e) => line(FLOW_STYLES.calls.color, '→', row(e, 'to'))))
      + section('Called by:', edgesOf('calls', 'to', node.id).map((e) => line(FLOW_STYLES.calls.color, '←', row(e, 'from'))))
      + section('Reads tables:', reads.filter((e) => e.to === node.id).map((e) => line(FLOW_STYLES.reads.color, '←', nm(e.from))))
      + section('Writes tables:', writes.filter((e) => e.from === node.id).map((e) => line(FLOW_STYLES.writes.color, '→', nm(e.to))))
      + section('Mechanisms:', (node.mechanisms || []).map((m) => line('#93c5fd', '◆', escHtml(m))));
  }
  if (node.type === 'container' && node.selfHosted) {
    // A self-hosted service is the container that runs it (spec 0031 section 3): what the API uses it for, who calls it, its webhook
    const row = (e, side) => `${nm(e[side])}${e.label && e.label !== 'calls' ? ` · ${escHtml(e.label)}` : ''}`;
    const into = state.edges.filter((e) => e.to === node.id && (e.kind === 'calls' || (e.kind === 'flow' && e.flow === 'api')));
    const calledBy = (type) => into.filter((e) => nodeById(e.from)?.type === type).map((e) => line(FLOW_STYLES.calls.color, '←', row(e, 'from')));
    const stackmates = new Set(state.nodes.filter((n) => n.type === 'container' && n.stack === node.stack).map((n) => n.id));
    return section('Self-hosted:', [line(FLOW_STYLES.calls.color, '◆', escHtml(node.summary || ''))])
      + section('Called by services:', calledBy('service'))
      + section('Called by endpoints:', calledBy('page'))
      + section('Called by apps:', calledBy('app'))
      + section('Pushes to (webhook):', state.edges.filter((e) => e.kind === 'delivers' && stackmates.has(e.from) && nodeById(e.to)?.type === 'page').map((e) => line(FLOW_STYLES.delivers.color, '→', `${nm(e.to)}${e.from === node.id ? '' : ` <span class="hx-faint">from ${escHtml(nameOf(e.from))}</span>`}`)));
  }
  if (node.type === 'external' && node.kind) { // a cloud node or the public web (spec 0031 section 6)
    return cloudPanelHtml(node, state.nodes, state.edges); // its File line is the registry
  }
  if (node.type === 'external') {
    const calledBy = (type) => edgesOf('calls', 'to', node.id).filter((e) => nodeById(e.from)?.type === type);
    return section('System:', [line(FLOW_STYLES.calls.color, '◆', `${escHtml(node.summary || '')}${node.host ? `<div class="hx-faint">Runs here as ${code(node.host)}</div>` : '<div class="hx-faint">Not run by this stack</div>'}`)])
      + section('Client modules:', (node.modules || []).map((m) => line('#fbbf24', 'ƒ', code(m))))
      + section('Called by services:', calledBy('service').map((e) => line(FLOW_STYLES.calls.color, '←', nm(e.from))))
      + section('Called by endpoints:', calledBy('page').map((e) => line(FLOW_STYLES.calls.color, '←', nm(e.from))))
      + section('Pushes to (webhook):', edgesOf('delivers', 'from', node.id).map((e) => line(FLOW_STYLES.delivers.color, '→', nm(e.to))));
  }
  if (node.type === 'page') {
    const r = node.render;
    const components = state.edges.filter((e) => e.dashed && e.from === node.id).map((e) => line('#818cf8', '→', nm(e.to)));
    return (node.methods ? section('Methods:', [line('#93c5fd', '⇢', node.methods.map(code).join(' '))]) : '')
      + (node.render_fn ? section('Rendered by:', [line('#93c5fd', 'ƒ', `${code(node.render_fn)} · ${escHtml(node.file)}`)]) : '')
      + section('Calls outside:', edgesOf('calls', 'from', node.id).map((e) => line(FLOW_STYLES.calls.color, '→', nm(e.to))))
      + section('Pushed to by:', edgesOf('delivers', 'to', node.id).map((e) => line(FLOW_STYLES.delivers.color, '←', `${nm(e.from)} · ${escHtml(e.label)}`)))
      + section('Starts:', edgesOf('triggers', 'from', node.id).map((e) => line(FLOW_STYLES.triggers.color, '→', `${nm(e.to)} · ${escHtml(e.label)}`)))
      + section('Renders:', components)
      + section('Reads:', reads.filter((e) => e.to === node.id).map((e) => line(FLOW_STYLES.reads.color, '←', `${nm(e.from)} · ${e.keys.map(code).join(' ')}`)))
      + section('Writes:', writes.filter((e) => e.from === node.id).map((e) => line(FLOW_STYLES.writes.color, '→', `${nm(e.to)} · ${escHtml(e.label)}`)))
      + (r ? section('Render:', [line(FLOW_STYLES.rom.color, '◆', `today: ${code(r.now)} · ROM: ${r.rom === 'bake' ? '<span class="hx-rom hx-bold">bake</span>' : '<span class="hx-faint">skip (per request)</span>'}${r.note ? `<div class="hx-faint">${escHtml(r.note)}</div>` : ''}`)]) : '');
  }
  return '';
}

// ---------------------------------------------------------------------------
//  The drawer
// ---------------------------------------------------------------------------
let selectToken = 0;

/** Selects a node: highlights its neighbourhood on the map and fills the side panel */
export async function selectNode(node) {
  if (!node) return;
  const token = ++selectToken;
  clearScenario();
  state.selectedNode = node;
  state.selectedEdge = null;
  touchScene();
  render();

  const propsList = $('drawer-props-list');
  const metaList = $('drawer-meta-list');
  const openBtn = $('drawer-open-btn');

  $('drawer-title').textContent = node.tag ? `<${node.tag}>` : node.label;
  $('drawer-badge').textContent = node.type === 'external' && node.kind ? (node.kind === 'web' ? 'PUBLIC WEB' : 'CLOUD') : node.type.toUpperCase();
  $('drawer-description').textContent = node.desc || '';
  if (token !== selectToken) return;

  propsList.innerHTML = `
    <div class="hx-prop">
      <div class="hx-prop-head">
        <span class="hx-accent hx-bold">Node Degree</span>
        <span class="hx-good hx-bold">${node.degree || 0} edges</span>
      </div>
      <div class="hx-faint">Radius: ${node.r}px (${node.scaleDelta > 0 ? '+' : ''}${(node.scaleDelta || 0).toFixed(1)}px subtle degree sizing)</div>
    </div>`;
  metaList.innerHTML = `
    <div><strong class="hx-strong">ID:</strong> ${escHtml(node.id)}</div>
    <div><strong class="hx-strong">Category:</strong> ${escHtml(node.type)}</div>
    <div><strong class="hx-strong">Connected Edges:</strong> <span class="hx-accent hx-bold">${node.degree || 0}</span></div>
    ${node.file ? `<div><strong class="hx-strong">File:</strong> <code class="hx-code">${escHtml(node.file)}</code></div>` : ''}
    ${flowSummary(node)}
    ${dataSummary(node)}`;
  if (node.url && /^https?:\/\//.test(node.url)) {
    openBtn.href = node.url;
    openBtn.textContent = 'Open Live Route ↗';
  } else {
    openBtn.removeAttribute('href');
    openBtn.textContent = 'Internal Workspace Node';
  }

  // A node a proposal touches: why, and what changes (before and after), above the rest
  const proposed = proposalPanelHtml(node);
  if (proposed) metaList.insertAdjacentHTML('afterbegin', proposed);

  // What the live layer knows of it (spec 0029): a count, a linked machine's item, contents and sets; repainted in place by live.js
  metaList.insertAdjacentHTML('beforeend', `<div id="drawer-live">${liveSection(node)}</div>`);
  hydrateLivePhotos($('drawer-live'));

  $('spec-drawer').classList.add('drawer-open');
  $('drawer-backdrop').hidden = false;
}

export function closeDrawer() {
  selectToken++;
  state.selectedEdge = null;
  clearScenario();
  $('spec-drawer').classList.remove('drawer-open');
  $('drawer-backdrop').hidden = true;
  collapseSheet('drawer'); // the next node opens as a peek on a phone
  state.selectedNode = null;
  touchScene();
  render();
}

/** Copies the selected node as JSON; the button says so for a moment */
export async function copySpec(button) {
  if (!state.selectedNode) return;
  const text = JSON.stringify({ node: state.selectedNode }, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied ✓';
  } catch {
    button.textContent = 'Copy blocked';
  }
  setTimeout(() => { button.textContent = 'Copy Spec'; }, 1500);
}
