/**
 * @module explorer/panels
 *
 * The side panel that opens when a node is selected: what the node is, and what the map knows about its data: the flows it is on, the
 * tables a page reads and writes, the services behind an endpoint, the stack an app runs on, and for a
 * cloud node (spec 0031) its plan, what breaks if it is down and who uses it, by when (cloud-model.js).
 */

import { state, nodeById, nameOf, escHtml, touchScene } from './state.js';
import { render } from './render.js';
import { flowSummary } from './flows.js';
import { clearScenario } from './scenario-ui.js';
import { kindOfMark, fieldRows, MARK_WORDS } from './proposal-model.js';
import { nodeMockupsHtml } from './mockups-model.js';
import { collapseSheet } from './sheets.js';
import { liveSection, hydrateLivePhotos } from './live.js';
import { cloudPanelHtml } from './cloud-model.js';
import { t } from './strings.js';
import { capped, toggleCapped } from './capped.js';
import { canStartAgent, openProposalStart } from './forge-panel.js';

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
      ? line(`<a class="hx-link" href="${escHtml(node.url)}" target="_blank" rel="noreferrer">${escHtml(node.url)}</a> → ${(node.upstreams || []).map(code).join(' ')}${node.stack ? ` <span class="hx-faint">[${escHtml(node.stack)}]</span>` : ''}`)
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
    return section('Kind:', [line(`${code(node.kind)}${node.summary ? `<div class="hx-faint">${escHtml(node.summary)}</div>` : ''}`)])
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
  const start = index.start ? `<button type="button" class="hx-btn hx-btn--quiet hx-textact" data-thread-start="${escHtml(node.id)}" aria-label="Start a thread about this: opens the New idea form for ${escHtml(index.forge())}, with this node mentioned">Start a thread about this</button>` : '';
  if (!threads || !threads.length) return start;
  const rows = threads.map((th) => {
    const count = Number(th.comments) || 0;
    return `<li><button type="button" class="hx-row hx-thread-open" data-thread-open="${th.number}" data-corn="row" aria-label="Open thread #${th.number}, ${escHtml(th.title)}, ${count} ${count === 1 ? 'comment' : 'comments'}, in the issues and pull requests panel"><span class="hx-row-title">${escHtml(th.title)}</span><span class="hx-row-meta">#${th.number} · ${count}</span></button></li>`;
  });
  return `<div class="hx-sec-block" data-corn="section"><h3 class="hx-sec-title">Threads</h3><ul class="hx-rows">${rows.join('')}</ul>${start}</div>`;
}

/** Draws "Mentioned in" again in the open panel (the list was just read, or the map changed); nothing else in the panel moves */
export function repaintThreads() {
  const box = $('drawer-threads');
  if (!box || !state.selectedNode) return;
  box.innerHTML = threadsSection(state.selectedNode);
}

// ---------------------------------------------------------------------------
//  The head: type · host, and what the open proposal does to the node
// ---------------------------------------------------------------------------

/** "Page", "Cloud", "Public web": the kind of node, in words */
function typeWords(node) {
  if (node.type === 'external' && node.kind) return node.kind === 'web' ? 'Public web' : 'Cloud';
  return node.type.charAt(0).toUpperCase() + node.type.slice(1);
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
  return `<div class="hx-sec-block" data-proposal-mark="${escHtml(node.mark)}" data-corn="section"><h3 class="hx-sec-title">In this proposal</h3>${node.why ? `<p class="hx-why">${escHtml(node.why)}</p>` : ''}<div class="hx-diff hx-diff--${escHtml(kind)}">${rows.join('')}</div></div>`;
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

  const metaList = $('drawer-meta-list');
  if (!metaList.dataset.moreBound) { metaList.dataset.moreBound = '1'; metaList.addEventListener('click', (e) => { toggleCapped(e.target); }); }
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
  const lead = $('drawer-description');
  lead.textContent = node.desc || '';
  lead.hidden = !node.desc;
  if (token !== selectToken) return;

  const facts = `${node.file ? section('File', [code(node.file)]) : ''}${flowSummary(node)}${dataSummary(node)}`;
  metaList.innerHTML = `${facts ? `<div class="hx-facts">${facts}</div>` : ''}
    <div id="drawer-live">${liveSection(node)}</div>
    ${nodeMockupsHtml(node.id)}
    <div id="drawer-threads">${threadsSection(node)}</div>
    ${diffSection(node)}`;
  if (state.threadIndex) state.threadIndex.ensure();
  hydrateLivePhotos($('drawer-live'));

  // The actions: Open (when the node has an address) is the primary one; Start a run, when the open proposal can be handed to an agent
  if (node.url && /^https?:\/\//.test(node.url)) {
    openBtn.href = node.url;
    openBtn.textContent = `${t('openRoute')} ↗`;
    openBtn.hidden = false;
  } else {
    openBtn.removeAttribute('href');
    openBtn.hidden = true;
  }
  const run = $('drawer-run-btn');
  run.hidden = !(state.proposalSlug && canStartAgent());

  $('spec-drawer').classList.add('drawer-open');
  $('spec-drawer').inert = false; // closed, it waits off screen: inert, so Tab never reaches its buttons (MAP-02)
  $('drawer-backdrop').hidden = false;
}

/** Start a run: the Start dialog of the Work panel, on the proposal that is open */
export function startRun() {
  if (state.proposalSlug) openProposalStart(state.proposalSlug);
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
  setTimeout(() => { button.textContent = t('copySpec'); }, 1500);
}
