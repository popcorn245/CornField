/**
 * @module explorer/panels
 *
 * The side panel that opens when a node is selected: what the node is, and what the map knows about its data: the flows it is on, the
 * tables a page reads and writes, the services behind an endpoint, the stack an app runs on, and for a
 * cloud node (spec 0031) its plan, what breaks if it is down and who uses it, by when (cloud-model.js).
 */

import { state, nodeById, nameOf, escHtml, touchScene, viewEdges } from './state.js';
import { render, onPaint } from './render.js';
import { flowSummary } from './flows.js';
import { clearScenario } from './scenario-ui.js';
import { kindOfMark, fieldRows, MARK_WORDS } from './proposal-model.js';
import { nodeMockupsHtml } from './mockups-model.js';
import { collapseSheet, isPhone, measureCovered, onCoveredChange, showSheet } from './sheets.js';
import { panIntoView } from './camera.js';
import { liveSection, hydrateLivePhotos } from './live.js';
import { cloudPanelHtml } from './cloud-model.js';
import { t } from './strings.js';
import { markStateAttr, markState } from './corn-state.js';
import { fileUrl } from './file-url.js';
import { capped, toggleCapped } from './capped.js';
import { dismissHint } from './hint.js';
import { canStartAgent, openProposalStart } from './forge-panel.js';
import { sayResult, clearResult, showResultIn, RESULT_MS } from './feedback.js';
import { activeSubgraph, connectedLine, farEnds, kindPanelWord, linesByKind } from './selection-model.js';
import { frameSelection, reach } from './selection-view.js';
import { announce } from './keyboard.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
//  Small HTML pieces shared by the sections below
// ---------------------------------------------------------------------------
const code = (s) => `<code class="hx-code">${escHtml(s)}</code>`;
const nm = (id) => `<span class="hx-name">${escHtml(nameOf(id))}</span>`;
const line = (body) => `<div class="hx-line">${body}</div>`;
/** The words a fact goes by in the panel: short nouns, whatever the longer sentence it was built from */
const FACT_KEYS = {
  'Uses design tokens': 'Tokens', 'Loaded by the server per request': 'Loaded by', 'Domains served (Caddyfile → service)': 'Domains', 'Compose file': 'File',
  'Baked pages': 'Baked', 'Reads tables': 'Reads', 'Writes tables': 'Writes', 'Self-hosted': 'Role', 'Pushes to (webhook)': 'Pushes to',
  'Calls outside': 'Calls', 'Client modules': 'Modules', 'Data flows': 'Flows',
};
const FACT_COUNTED = /^(?:Defines )?\d+ (?:CSS )?(variable|service)\(s\)$/;
const factKey = (title) => {
  const plain = title.replace(/:$/, '');
  const counted = FACT_COUNTED.exec(plain);
  if (counted) return counted[1] === 'service' ? 'Services' : plain.startsWith('Defines') ? 'Defines' : 'Variables';
  return FACT_KEYS[plain] || plain;
};
/** One fact: its name, and what it says. A fact with nothing in it is not shown. */
const section = (title, rows) => (rows.length ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">${escHtml(factKey(title))}</div><div class="hx-fact-v">${capped(rows)}</div></div>` : '');
const varList = (vars) => `<div class="hx-chips">${capped(vars.map((v) => `<code class="hx-var">${escHtml(v)}</code>`))}</div>`;
const edgesOf = (kind, side, id) => state.edges.filter((e) => e.kind === kind && e[side] === id);

/** Table <-> page data: which keys a page's render reads, which forms write, what ROM re-bakes */
function dataSummary(node) {
  const reads = state.edges.filter((e) => e.kind === 'reads');
  const writes = state.edges.filter((e) => e.kind === 'writes');
  const usesOut = state.edges.filter((e) => e.kind === 'uses' && e.from === node.id);
  const extendsOut = state.edges.filter((e) => e.kind === 'extends' && e.from === node.id);
  const common = section('Extends:', extendsOut.map((e) => line(nm(e.to))))
    + section('Uses design tokens:', usesOut.map((e) => line(`${nm(e.to)} · ${e.vars.length}${varList(e.vars)}`)))
    + (node.type !== 'token' && node.vars ? section(`Defines ${node.vars.length} CSS variable(s):`, [varList(node.vars)]) : '');

  if (node.type === 'app') {
    const served = node.deployed
      ? line(`${/^https?:\/\//.test(node.url) ? `<a data-corn="text-link" class="hx-link" href="${escHtml(node.url)}" target="_blank" rel="noreferrer">${escHtml(node.url)}</a>` : code(node.url)} → ${(node.upstreams || []).map(code).join(' ')}${node.stack ? ` <span class="hx-faint">[${escHtml(node.stack)}]</span>` : ''}`)
      : line('Not deployed by any stack in this repo');
    const runsOn = state.edges.filter((e) => e.kind === 'runs-on' && e.from === node.id)
      .map((e) => line(`${nm(e.to)}${(e.mappings || []).map((m) => `<div class="hx-faint">${code(m.host)} → ${code(m.upstream)}${m.service ? ` = ${code(m.service)}` : ''}</div>`).join('')}`));
    return section('Served:', [served])
      + section('Runs on:', runsOn)
      + section('Loaded by the server per request:', reads.filter((e) => e.to === node.id).map((e) => line(nm(e.from))))
      + common;
  }
  if (node.type === 'token') {
    const users = state.edges.filter((e) => e.kind === 'uses' && e.to === node.id);
    return section(`${node.vars.length} variable(s):`, [varList(node.vars)])
      + section('Used by:', users.map((e) => line(`${nm(e.from)} · ${escHtml(e.vars.join(' '))}`)));
  }
  if (['atom', 'molecule', 'core'].includes(node.type)) {
    const pages = state.edges.filter((e) => e.dashed && e.to === node.id).map((e) => line(nm(e.from)));
    return (node.table ? section('Record of:', [line(`${escHtml(node.model)} · table ${code(node.table)}`)]) : '')
      + section('Rendered by:', pages) + common;
  }
  if (node.type === 'stack') {
    const served = state.edges.filter((e) => e.kind === 'runs-on' && e.to === node.id);
    return section('Domains served (Caddyfile → service):', served.flatMap((e) => (e.mappings || []).map((m) => line(`<span class="hx-name">${escHtml(m.host)}</span> → ${code(m.upstream)}${m.service ? ` = ${code(m.service)}` : ''}`))))
      + section(`${(node.services || []).length} service(s):`, (node.services || []).map((s) => line(`<span class="hx-name">${escHtml(s.name)}</span>${s.image ? ` <span class="hx-faint">${escHtml(s.image)}</span>` : ''}${s.ports.length ? `<div>${s.ports.map(code).join(' ')}</div>` : ''}${s.volumes.length ? `<div class="hx-faint">${s.volumes.map(escHtml).join('<br>')}</div>` : ''}`)))
      + section('Compose file:', [line(code(node.file))]);
  }
  if (node.type === 'table') {
    const readers = reads.filter((e) => e.from === node.id);
    const writers = writes.filter((e) => e.to === node.id);
    const baked = readers.filter((e) => (nodeById(e.to) || {}).render?.rom === 'bake');
    return (node.model ? section('Model:', [line(escHtml(node.model))]) : '')
      + section('Read by:', readers.map((e) => line(`${nm(e.to)} · ${e.keys.map(code).join(' ')}`)))
      + section('Written by:', writers.map((e) => line(`${nm(e.from)} · ${escHtml(e.label)}`)))
      + (baked.length ? section('Baked pages:', [line(`a write here re-bakes <span class="hx-rom hx-bold">${baked.length}</span> file(s): ${baked.map((e) => escHtml(nameOf(e.to))).join(', ')}`)]) : '');
  }
  if (node.type === 'service') {
    const row = (e, side) => `${nm(e[side])}${e.label && e.label !== 'imports' ? ` · ${escHtml(e.label)}` : ''}`;
    // The summary is the first sentence of the description above: shown again only when the description does not hold it
    const again = node.summary && !String(node.desc || '').includes(node.summary);
    // The kind is in the badge ("Service · timer", typeWords): it has no row of its own
    return (again ? section('Summary:', [line(`<span class="hx-faint">${escHtml(node.summary)}</span>`)]) : '')
      + section('Started by:', [...(node.triggers || []).map((t) => line(escHtml(t))), ...edgesOf('triggers', 'to', node.id).map((e) => line(row(e, 'from')))])
      + section('Jobs:', (node.jobs || []).map((j) => line(`${code(j.name)} · cron ${code(j.cron)}`)))
      + section('Runs:', edgesOf('triggers', 'from', node.id).map((e) => line(row(e, 'to'))))
      + section('Calls:', edgesOf('calls', 'from', node.id).map((e) => line(row(e, 'to'))))
      + section('Called by:', edgesOf('calls', 'to', node.id).map((e) => line(row(e, 'from'))))
      + section('Reads tables:', reads.filter((e) => e.to === node.id).map((e) => line(nm(e.from))))
      + section('Writes tables:', writes.filter((e) => e.from === node.id).map((e) => line(nm(e.to))))
      + section('Mechanisms:', (node.mechanisms || []).map((m) => line(escHtml(m))));
  }
  if (node.type === 'container' && node.selfHosted) {
    // A self-hosted service is the container that runs it (spec 0031 section 3): what the API uses it for, who calls it, its webhook
    const row = (e, side) => `${nm(e[side])}${e.label && e.label !== 'calls' ? ` · ${escHtml(e.label)}` : ''}`;
    const into = state.edges.filter((e) => e.to === node.id && (e.kind === 'calls' || (e.kind === 'flow' && e.flow === 'api')));
    const calledBy = (type) => into.filter((e) => nodeById(e.from)?.type === type).map((e) => line(row(e, 'from')));
    const stackmates = new Set(state.nodes.filter((n) => n.type === 'container' && n.stack === node.stack).map((n) => n.id));
    return section('Self-hosted:', [line(escHtml(node.summary || ''))])
      + section('Called by services:', calledBy('service'))
      + section('Called by endpoints:', calledBy('page'))
      + section('Called by apps:', calledBy('app'))
      + section('Pushes to (webhook):', state.edges.filter((e) => e.kind === 'delivers' && stackmates.has(e.from) && nodeById(e.to)?.type === 'page').map((e) => line(`${nm(e.to)}${e.from === node.id ? '' : ` <span class="hx-faint">from ${escHtml(nameOf(e.from))}</span>`}`)));
  }
  if (node.type === 'external' && node.kind) { // a cloud node or the public web (spec 0031 section 6)
    return cloudPanelHtml(node, state.nodes, state.edges); // its File line is the registry
  }
  if (node.type === 'external') {
    const calledBy = (type) => edgesOf('calls', 'to', node.id).filter((e) => nodeById(e.from)?.type === type);
    return section('System:', [line(`${escHtml(node.summary || '')}${node.host ? `<div class="hx-faint">Runs here as ${code(node.host)}</div>` : '<div class="hx-faint">Not run by this stack</div>'}`)])
      + section('Client modules:', (node.modules || []).map((m) => line(code(m))))
      + section('Called by services:', calledBy('service').map((e) => line(nm(e.from))))
      + section('Called by endpoints:', calledBy('page').map((e) => line(nm(e.from))))
      + section('Pushes to (webhook):', edgesOf('delivers', 'from', node.id).map((e) => line(nm(e.to))));
  }
  if (node.type === 'page') {
    const r = node.render;
    const components = state.edges.filter((e) => e.dashed && e.from === node.id).map((e) => line(nm(e.to)));
    return (node.methods ? section('Methods:', [line(node.methods.map(code).join(' '))]) : '')
      + (node.render_fn ? section('Rendered by:', [line(`${code(node.render_fn)} · ${escHtml(node.file)}`)]) : '')
      + section('Calls outside:', edgesOf('calls', 'from', node.id).map((e) => line(nm(e.to))))
      + section('Pushed to by:', edgesOf('delivers', 'to', node.id).map((e) => line(`${nm(e.from)} · ${escHtml(e.label)}`)))
      + section('Starts:', edgesOf('triggers', 'from', node.id).map((e) => line(`${nm(e.to)} · ${escHtml(e.label)}`)))
      + section('Renders:', components)
      + section('Reads:', reads.filter((e) => e.to === node.id).map((e) => line(`${nm(e.from)} · ${e.keys.map(code).join(' ')}`)))
      + section('Writes:', writes.filter((e) => e.from === node.id).map((e) => line(`${nm(e.to)} · ${escHtml(e.label)}`)))
      + (r ? section('Render:', [line(`today: ${code(r.now)} · ROM: ${r.rom === 'bake' ? '<span class="hx-rom hx-bold">bake</span>' : '<span class="hx-faint">skip (per request)</span>'}${r.note ? `<div class="hx-faint">${escHtml(r.note)}</div>` : ''}`)]) : '');
  }
  return '';
}

// ---------------------------------------------------------------------------
//  Threads that mention the node
// ---------------------------------------------------------------------------

/** "Threads": the threads whose text names the node (an idea, or a spec PR's conversation); each opens in the Work panel */
function threadsSection(node) {
  const index = state.threadIndex;
  if (!index) return '';
  const threads = index.for(node.id);
  // "Start a thread about this" shows whenever threads are on and a maintainer is signed in (the panel only sets `start` then)
  const start = index.start ? `<button data-corn-kind="quiet" type="button" class="hx-btn hx-btn--quiet hx-textact" data-thread-start="${escHtml(node.id)}" aria-label="Start a thread about this: opens the New idea form for ${escHtml(index.forge())}, with this node mentioned">Start a thread about this</button>` : '';
  if (!threads || !threads.length) return start;
  const rows = threads.map((th) => {
    const count = Number(th.comments) || 0;
    return `<li><button type="button" class="hx-row hx-thread-open" data-thread-open="${escHtml(th.number)}" data-corn="row" aria-label="Open thread #${escHtml(th.number)}, ${escHtml(th.title)}, ${count} ${count === 1 ? 'comment' : 'comments'}, in the issues and pull requests panel"><span class="hx-row-title">${escHtml(th.title)}</span><span class="hx-row-meta">#${escHtml(th.number)} · ${count}</span></button></li>`;
  });
  return `<div class="hx-sec-block" data-corn="section"><h3 class="hx-sec-title">Threads</h3><ul class="hx-rows">${rows.join('')}</ul>${start}</div>`;
}

/** Draws "Threads" again in the open panel (the list was just read, or the map changed); nothing else in the panel moves */
export function repaintThreads() {
  const box = $('drawer-threads');
  if (!box || !state.selectedNode) return;
  box.innerHTML = threadsSection(state.selectedNode);
}

// ---------------------------------------------------------------------------
//  The head: type · host, and what the open proposal does to the node
// ---------------------------------------------------------------------------

/** "Page", "Cloud", "Public web", "Service · timer": the kind of node, in words, with its finer kind (spec 0009 D5) after a dot. A kind is text, shown as text */
function typeWords(node) {
  if (node.type === 'external' && node.kind) return node.kind === 'web' ? 'Public web' : 'Cloud';
  const type = node.type.charAt(0).toUpperCase() + node.type.slice(1);
  return typeof node.kind === 'string' && node.kind ? `${type} · ${node.kind}` : type;
}

/** The host a node answers on, when it has one */
function hostOf(node) {
  if (node.url) { try { return new URL(node.url).host; } catch { /* not a URL: no host */ } }
  return node.host || '';
}

/** "Added by Checkout": the pill for a node the open proposal touches; '' for one it leaves alone */
export function diffPillWords(node) {
  const mark = node && node.mark;
  if (!mark || mark === 'none') return '';
  if (mark === 'edit') return `${node.editOp === 'removed' ? 'Removed' : 'Added'} by your edit`;
  const title = state.proposal && typeof state.proposal.title === 'string' ? state.proposal.title : '';
  return title ? `${MARK_WORDS[mark] || mark} by ${title}` : `${MARK_WORDS[mark] || mark} by this proposal`;
}

/** "In this proposal": the diff for a changed node as key/value rows (id, parent, edges +2; a change shows each field before and after) */
function diffSection(node) {
  const kind = kindOfMark(node);
  if (!diffPillWords(node)) return '';
  const row = (k, v) => `<div class="hx-diff-k">${escHtml(k)}</div><div class="hx-diff-v">${v}</div>`;
  const rows = [row('id', escHtml(node.id))];
  const parent = state.edges.find((e) => !e.kind && !e.dashed && e.to === node.id);
  if (parent) rows.push(row('parent', escHtml(parent.from)));
  const touching = state.edges.filter((e) => e.from === node.id || e.to === node.id);
  const added = touching.filter((e) => kindOfMark(e) === 'added').length;
  const removed = touching.filter((e) => kindOfMark(e) === 'removed').length;
  if (added || removed) rows.push(row('edges', escHtml([added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' '))));
  if (kind === 'changed') {
    for (const r of fieldRows(node)) rows.push(row(r.field, `<span class="hx-change-before">${escHtml(r.before) || '<em>nothing</em>'}</span> <span aria-hidden="true">→</span><span class="hx-sr-only"> became </span> <span class="hx-change-after">${escHtml(r.after) || '<em>nothing</em>'}</span>`));
  }
  return `<div class="hx-sec-block" data-proposal-mark="${escHtml(node.mark)}" data-corn="section"><h3 class="hx-sec-title">In this proposal</h3>${node.why ? `<p class="hx-why">${escHtml(node.why)}</p>` : ''}<div class="hx-diff hx-diff--${escHtml(kind)}" data-corn="diff-block"${markStateAttr(node.mark)}>${rows.join('')}</div></div>`;
}

// ---------------------------------------------------------------------------
//  What the selection lights: the lines by kind, the switch, Frame them (spec 0008 D5 and D6)
// ---------------------------------------------------------------------------

/** The most rows a kind's list shows before "and N more" */
export const LINES_CAP = 12;

/** The lit set the panel describes: the same rule the scene lights by (selection-model.js) */
const litNow = () => activeSubgraph(state.selectedNode, viewEdges(), { throughChildren: state.throughChildren, kind: state.selectedKind });

/** The panel's "Calls 12 · Reads 9" chips, the chosen kind's far ends, the switch, and the line that says how much is on screen, with Frame them */
function linesHtml(node) {
  const sub = litNow();
  if (!sub || !sub.kinds.size) return '';
  const kinds = linesByKind(sub);
  const chips = kinds.map(({ kind, count, word }) => `<button type="button" class="hx-lines-kind" data-corn="lines-kind" data-corn-kind="quiet" data-lines-kind="${escHtml(kind)}" data-focus-key="kind:${escHtml(kind)}" aria-pressed="${sub.kind === kind}">${escHtml(word)} <span class="hx-lines-count" data-corn="count">${count}</span></button>`).join('');
  const open = sub.kind ? farEnds(sub, sub.kind).map((r) => `<button type="button" class="hx-linkbtn" data-corn="node-link" data-action="select-node" data-id="${escHtml(r.id)}"><span class="hx-sr-only">${r.out ? 'to ' : 'from '}</span><span aria-hidden="true">${r.out ? '→' : '←'}</span> ${escHtml(nameOf(r.id))}</button>`) : [];
  const list = open.length ? `<div class="hx-lines-list">${capped(open, LINES_CAP)}</div>` : '';
  const hasChildren = activeSubgraph(node, viewEdges(), { throughChildren: false }).childIds.size > 0;
  const through = hasChildren ? `<label class="hx-lines-switch"><input type="checkbox" data-corn="lines-switch" data-lines-switch data-focus-key="switch"${state.throughChildren ? ' checked' : ''}> <span>${escHtml(t('throughChildren'))}</span></label>` : '';
  const { connected, off } = reach();
  return `<div class="hx-sec-block hx-lines" id="drawer-lines" data-corn="lines-by-kind"><h3 class="hx-sec-title">Lines</h3><div class="hx-chips" role="group" aria-label="Lit lines by kind">${chips}</div>${list}${through}<div class="hx-lines-reach"><span data-lines-reach>${escHtml(connectedLine(connected, off))}</span> <button type="button" data-corn="frame-button" data-corn-kind="secondary" class="hx-btn hx-btn--secondary" data-action="frame-selection" data-focus-key="frame">${escHtml(t('frame'))}</button></div></div>`;
}

/** Draws the lines block again after a switch or a kind was chosen; the focus stays on the control that was used */
function paintLines() {
  const box = $('drawer-lines');
  if (!box || !state.selectedNode) return;
  const key = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.focusKey : '';
  const html = linesHtml(state.selectedNode);
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const next = holder.firstElementChild;
  if (next) box.replaceWith(next); else box.remove();
  if (key) { const again = $('drawer-lines'); const el = again && [...again.querySelectorAll('[data-focus-key]')].find((x) => x.dataset.focusKey === key); if (el) el.focus(); }
}

/** One step through the panel's lines controls: a kind's chip lights that kind alone (the same chip again lights them all), the switch widens the set */
function onLinesClick(e) {
  const chip = e.target.closest && e.target.closest('[data-lines-kind]');
  if (!chip || !state.selectedNode) return false;
  const kind = chip.dataset.linesKind;
  state.selectedKind = state.selectedKind === kind ? null : kind;
  touchScene();
  render();
  paintLines();
  const sub = litNow();
  announce(sub && sub.kind ? `Showing ${kindPanelWord(sub.kind).toLowerCase()} only: ${sub.edges.length} ${sub.edges.length === 1 ? 'line' : 'lines'}` : 'Showing every kind of line');
  return true;
}
function onLinesChange(e) {
  const box = e.target.closest && e.target.closest('[data-lines-switch]');
  if (!box || !state.selectedNode) return;
  state.throughChildren = !!box.checked;
  state.selectedKind = null; // the set changed under the chosen kind: it may not be in it
  touchScene();
  render();
  paintLines();
  const sub = litNow();
  announce(`${state.throughChildren ? 'Including' : 'Not including'} its children's lines: ${sub ? sub.connectedNodeIds.size - 1 : 0} connected`);
}

/** Keeps "9 connected · 3 off screen" true as the camera moves (after every draw, while a node is selected and its panel is open) */
onPaint(() => {
  if (!state.selectedNode) return;
  const el = document.querySelector('[data-lines-reach]');
  if (!el) return;
  const { connected, off } = reach();
  const text = connectedLine(connected, off);
  if (el.textContent !== text) el.textContent = text;
});

// ---------------------------------------------------------------------------
//  The drawer
// ---------------------------------------------------------------------------
let selectToken = 0;

/**
 * Selects a node: lights what is one edge from it on the map and fills the side panel. `frame` is for a selection that did not come
 * from a click on the map (a search, a list, a link, the keyboard): the camera then flies to the node and what it lights (selection-model.js);
 * a click leaves the camera where it is (spec 0008 D6).
 */
export async function selectNode(node, { frame = false } = {}) {
  if (!node) return;
  const token = ++selectToken;
  clearScenario();
  dismissHint(); // a node has been picked: the hint's job is done for this session
  if (!state.selectedNode || state.selectedNode.id !== node.id) state.selectedKind = null; // a kind chosen for one node means nothing for the next
  state.selectedNode = node;
  state.selectedEdge = null;
  touchScene();
  render();

  const metaList = $('drawer-meta-list');
  if (!metaList.dataset.moreBound) {
    metaList.dataset.moreBound = '1';
    metaList.addEventListener('click', (e) => { if (!onLinesClick(e)) toggleCapped(e.target); });
    metaList.addEventListener('change', onLinesChange);
  }
  const openBtn = $('drawer-open-btn');
  const title = $('drawer-title');

  title.textContent = node.tag ? `<${node.tag}>` : node.label;
  title.classList.toggle('hx-mono', node.type === 'page' || !!node.tag); // a route or a tag reads as code
  $('drawer-badge').textContent = typeWords(node);
  const host = hostOf(node);
  $('drawer-host').textContent = host ? ` · ${host}` : '';
  const pill = diffPillWords(node);
  $('drawer-diff').textContent = pill;
  $('drawer-diff').hidden = !pill;
  const pillState = markState(pill ? node.mark : ''); // added, changed, removed or edit
  if (pillState) $('drawer-diff').dataset.cornState = pillState; else delete $('drawer-diff').dataset.cornState;
  const lead = $('drawer-description');
  lead.textContent = node.desc || '';
  lead.hidden = !node.desc;
  if (token !== selectToken) return;

  const facts = `${node.file ? section('File', [code(node.file)]) : ''}${flowSummary(node)}${dataSummary(node)}`;
  metaList.innerHTML = `${linesHtml(node)}${facts ? `<div class="hx-facts">${facts}</div>` : ''}
    <div id="drawer-live">${liveSection(node)}</div>
    ${nodeMockupsHtml(node.id)}
    <div id="drawer-threads">${threadsSection(node)}</div>
    ${diffSection(node)}`;
  if (state.threadIndex) state.threadIndex.ensure();
  hydrateLivePhotos($('drawer-live'));

  // The actions: Open file (the node's file on the forge) is the primary one; with an address too, Open route is the quiet one.
  // The proposal's head branch is not known here (the proposals list does not carry it): the file is at the default branch.
  const fileBtn = $('drawer-file-btn');
  const file = node.file && state.forge ? fileUrl(state.forge, node.file, state.forge.baseBranch) : null;
  fileBtn.hidden = !file;
  if (file) fileBtn.href = file; else fileBtn.removeAttribute('href');
  const route = !!(node.url && /^https?:\/\//.test(node.url));
  if (route) openBtn.href = node.url; else openBtn.removeAttribute('href');
  openBtn.hidden = !route;
  openBtn.className = file ? 'hx-btn hx-btn--quiet hx-foot-btn' : 'hx-open';
  if (file) openBtn.dataset.cornKind = 'quiet'; else openBtn.dataset.cornKind = 'primary'; // the route is the primary action when there is no file
  openBtn.textContent = `${t('openRoute')} ↗`;
  fileBtn.textContent = `${t('openFile')} ↗`;
  const run = $('drawer-run-btn');
  run.hidden = !(state.proposalSlug && canStartAgent());

  $('spec-drawer').classList.add('drawer-open');
  $('spec-drawer').inert = false; // closed, it waits off screen: inert, so Tab never reaches its buttons (MAP-02)
  $('drawer-backdrop').hidden = false;
  showSheet('drawer'); // on a phone it takes Work's place (the node sheet and Work take turns), and comes back from away when its node is tapped again
  if (frame) frameSelection(); // the panel is open now, so what it covers is known
  else keepSelectedInView();
}

/**
 * On a phone the node's sheet covers the bottom of the map (sheets.js): when the selected node is under it, or
 * gets covered as the sheet expands, pan the map (never zoom it) so the node is in the part still showing (F32)
 */
export function keepSelectedInView() {
  const node = state.selectedNode;
  if (!node || !state.width || !isPhone()) return;
  const covered = measureCovered();
  const next = panIntoView(state.camera, node, { left: 0, top: 0, right: state.width, bottom: state.height - covered }, node.r * state.camera.zoom + 16);
  if (!next) return;
  Object.assign(state.camera, next);
  render();
}
onCoveredChange(() => keepSelectedInView());

/** Start a run: the Start dialog of the Work panel, on the proposal that is open */
export function startRun() {
  if (state.proposalSlug) openProposalStart(state.proposalSlug, '#drawer-run-btn');
}

export function closeDrawer() {
  selectToken++;
  state.selectedEdge = null;
  clearScenario();
  $('spec-drawer').classList.remove('drawer-open');
  $('spec-drawer').inert = true;
  $('drawer-backdrop').hidden = true;
  collapseSheet('drawer'); // the next node opens as a peek on a phone
  state.selectedNode = null;
  touchScene();
  render();
}

let copyTimer = 0;
/** Copies the selected node as JSON; the result is said under the button and to a screen reader, and stays a few seconds */
export async function copySpec(button) {
  if (!state.selectedNode) return;
  const text = JSON.stringify({ node: state.selectedNode }, null, 2);
  clearTimeout(copyTimer);
  clearResult('copy-spec');
  const where = $('copy-spec-result');
  try {
    await navigator.clipboard.writeText(text);
    sayResult('copy-spec', `Copied the spec of ${state.selectedNode.label || state.selectedNode.id} to the clipboard.`, true);
  } catch {
    sayResult('copy-spec', 'The browser did not allow copying, so nothing was copied. Allow clipboard access for this page, then press Copy Spec again.', false);
  }
  showResultIn(where, 'copy-spec');
  copyTimer = setTimeout(() => { clearResult('copy-spec'); showResultIn(where, 'copy-spec'); }, RESULT_MS);
}
