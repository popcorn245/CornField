/**
 * @module explorer/pieces/node-panel
 *
 * The node panel as a piece (spec 0011 D3): the side panel that opens when a node is selected, with what the node is and what the map knows
 * about its data: the flows it is on, the tables a page reads and writes, the services behind an endpoint, the stack an app runs on, and for a
 * cloud node (spec 0031) its plan, what breaks if it is down and who uses it, by when (cloud-model.js). A slide-over on a desktop, a bottom
 * sheet on a phone (engine/sheets.js).
 *
 *   mount(root, inst, options) -> { update, destroy, ... }
 *
 * The piece makes its own markup (`markup()`: the panel and the dim layer behind it on a phone) and puts it in `root`, or before the nodes
 * `options.slots` names (`drawer`, `backdrop`). It follows the instance: `node:show` fills and opens it for a node, `node:close` closes it
 * (engine/selection.js, which is how every selection reaches it), and it announces `node:painted`. What it needs of neighbours that may not be
 * there it asks (instance.js): `live:section` (the live layer's block), `live:hydrate`, `forge:can-start` and `forge:start` (the Start a run
 * button). Its buttons are its own: Close, Copy Spec, Start a run, a link to a node, Frame them. `destroy()` takes back every listener and timer
 * and removes the elements.
 *
 * @param {ParentNode} root where the panel goes when `options.slots` names no place
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst the instance; its map must be made (engine/render.js)
 * `options.inline` is the panel in a box of its own (`<corn-node-panel>`): it fills the box its host gives it instead of sliding over the map, never becomes a phone's
 * bottom sheet (no dock, no dim layer: the host's layout decides where it is), says what it needs while nothing is selected (`empty`), and covers nothing of the map.
 *
 * @param {{ slots?: { drawer?: Node, backdrop?: Node }, inline?: boolean }} [options]
 * @returns {{ update: (props?: { node?: object | null }) => void, destroy: () => void, show: Function, close: Function, repaintThreads: Function, copySpec: Function, startRun: Function, keepSelectedInView: Function, elements: Element[] }}
 *   `update({ node })` shows that node (or closes the panel for `null`) without selecting it; `update()` paints the open panel again from the
 *   instance's state (after the host changed the topology or the words).
 */

import { escapeHtml as escHtml } from '../../core/text.js';
import { flowSummary } from '../engine/flow-ui.js';
import { kindOfMark, fieldRows, MARK_WORDS, proposalPanelHtml } from '../proposal-model.js';
import { nodeMockupsHtml } from '../mockups-model.js';
import { collapseSheet, initSheets, isPhone, measureCovered, onCoveredChange, registerSheet, unregisterSheet, showSheet, onBackdrop } from '../engine/sheets.js';
import { panIntoView } from '../camera-frame.js';
import { cloudPanelHtml } from '../cloud-panel.js';
import { t } from '../engine/strings.js';
import { markStateAttr, markState } from '../corn-state.js';
import { fileUrl } from '../file-url.js';
import { capped, toggleCapped } from '../capped.js';
import { sayResult, clearResult, showResultIn, RESULT_MS } from '../engine/feedback.js';
import { activeSubgraph } from '../selection-model.js';
import { connectedLine, farEnds, kindPanelWord, linesByKind } from '../selection-words.js';
import { reach } from '../selection-view.js';
import { announce, frameThem } from '../engine/keyboard.js';
import { selectNode, clearSelection } from '../engine/selection.js';
import { scopeOf, place, addParts } from '../engine/piece.js';

// ---------------------------------------------------------------------------
//  Small HTML pieces shared by the sections below
// ---------------------------------------------------------------------------
const code = (s) => `<code class="hx-code">${escHtml(s)}</code>`;
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
export function diffPillWords(node, proposal) {
  const mark = node && node.mark;
  if (!mark || mark === 'none') return '';
  if (mark === 'edit') return `${node.editOp === 'removed' ? 'Removed' : 'Added'} by your edit`;
  const title = proposal && typeof proposal.title === 'string' ? proposal.title : '';
  return title ? `${MARK_WORDS[mark] || mark} by ${title}` : `${MARK_WORDS[mark] || mark} by this proposal`;
}

/** The most rows a kind's list shows before "and N more" */
export const LINES_CAP = 12;

/** The markup of the piece: the panel (a sheet in the dock on a phone) and the dim layer behind it. `drawer` and `backdrop` are the two places */
/** The markup of the piece: the panel (a sheet in the dock on a phone) and the dim layer behind it. `drawer` and `backdrop` are the two places */
export const markup = () => ({
  drawer: '<aside id="spec-drawer" class="hx-drawer glass" aria-label="Node details" inert data-corn="node-panel">'
    + '<div class="hx-drawer-body">'
    + '<div class="hx-drawer-head">'
    + '<div class="hx-drawer-id">'
    + '<p class="hx-kicker"><span id="drawer-badge" data-corn="badge">Atom</span><span id="drawer-host" data-corn="node-host"></span><span id="drawer-diff" class="hx-diffpill" data-corn="diff-pill" hidden></span></p>'
    + '<h2 id="drawer-title" class="hx-drawer-title" data-corn="node-title">&lt;pop-button&gt;</h2>'
    + '</div>'
    + '<button type="button" class="hx-close" data-action="close-drawer" aria-label="Close" data-corn-kind="icon">✕</button>'
    + '</div>'
    + '<p id="drawer-description" class="hx-lead" hidden></p>'
    + '<div class="hx-block"><div id="drawer-meta-list" class="hx-meta"></div></div>'
    + '</div>'
    + '<div class="hx-drawer-foot" data-corn="node-foot">'
    + '<a data-corn="open-link" id="drawer-file-btn" data-corn-kind="primary" class="hx-open" href="#" target="_blank" rel="noreferrer" hidden>Open file ↗</a>'
    + '<a data-corn="open-link" id="drawer-open-btn" data-corn-kind="primary" class="hx-open" href="#" target="_blank" rel="noreferrer" hidden>Open route ↗</a>'
    + '<button data-corn-kind="secondary" type="button" id="drawer-run-btn" class="hx-btn hx-foot-btn" data-action="start-run" data-corn-string="startRun" hidden>Start a run</button>'
    + '<button data-corn-kind="quiet" type="button" class="hx-btn hx-btn--quiet hx-foot-btn" data-action="copy-spec" data-corn-string="copySpec">Copy Spec</button>'
    + '<p id="copy-spec-result" class="hx-forge-result" data-corn="result" hidden></p>'
    + '</div>'
    + '</aside>',
  backdrop: '<div id="drawer-backdrop" class="hx-backdrop" data-action="close-drawer" hidden data-corn="backdrop"></div>',
});

/** The timer that ends a copy's result; the instance's own, so a second panel does not end the first one's */
const copyState = (inst) => inst.slot('copy-spec', () => ({ timer: 0 }));

/**
 * Copies the selected node as JSON; the result is said under the button (`where`, a `data-corn="result"` element) and to a screen reader,
 * and stays a few seconds.
 */
export async function copySpec(inst, where) {
  const { state } = inst;
  if (!state.selectedNode) return;
  const mem = copyState(inst);
  const text = JSON.stringify({ node: state.selectedNode }, null, 2);
  clearTimeout(mem.timer);
  clearResult(inst, 'copy-spec');
  try {
    await inst.win.navigator.clipboard.writeText(text);
    sayResult(inst, 'copy-spec', `Copied the spec of ${state.selectedNode.label || state.selectedNode.id} to the clipboard.`, true);
  } catch {
    sayResult(inst, 'copy-spec', 'The browser did not allow copying, so nothing was copied. Allow clipboard access for this page, then press Copy Spec again.', false);
  }
  showResultIn(inst, where, 'copy-spec');
  mem.timer = setTimeout(() => { clearResult(inst, 'copy-spec'); showResultIn(inst, where, 'copy-spec'); }, RESULT_MS);
}

/**
 * The sections of the panel, for an instance: they read its state and nothing else.
 * @param {ReturnType<typeof import('../instance.js').createInstance>} inst
 */
function sectionsOf(inst) {
  const { state } = inst;
  const nodeById = (id) => state.nodes.find((n) => n.id === id);
  const nameOf = (id) => (nodeById(id) || { label: id }).label;
  const nm = (id) => `<span class="hx-name">${escHtml(nameOf(id))}</span>`;
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

  /** "Threads": the threads whose text names the node (an idea, or a spec PR's conversation); each opens in the Work panel */
  function threadsSection(node) {
    // The Work panel answers (threads:index) when threads are on and a maintainer is signed in; nobody answering is no Threads section
    const index = inst.ask('threads:index', node.id);
    if (!index) return '';
    const threads = index.threads;
    // "Start a thread about this" shows whenever threads are on and a maintainer is signed in (the panel only answers then)
    const start = index.start ? `<button data-corn-kind="quiet" type="button" class="hx-btn hx-btn--quiet hx-textact" data-thread-start="${escHtml(node.id)}" aria-label="Start a thread about this: opens the New idea form for ${escHtml(index.forge)}, with this node mentioned">Start a thread about this</button>` : '';
    if (!threads || !threads.length) return start;
    const rows = threads.map((th) => {
      const count = Number(th.comments) || 0;
      return `<li><button type="button" class="hx-row hx-thread-open" data-thread-open="${escHtml(th.number)}" data-corn="row" aria-label="Open thread #${escHtml(th.number)}, ${escHtml(th.title)}, ${count} ${count === 1 ? 'comment' : 'comments'}, in the issues and pull requests panel"><span class="hx-row-title">${escHtml(th.title)}</span><span class="hx-row-meta">#${escHtml(th.number)} · ${count}</span></button></li>`;
    });
    return `<div class="hx-sec-block" data-corn="section"><h3 class="hx-sec-title">Threads</h3><ul class="hx-rows">${rows.join('')}</ul>${start}</div>`;
  }

  /** "In this proposal": the diff for a changed node as key/value rows (id, parent, edges +2; a change shows each field before and after) */
  function diffSection(node) {
    const kind = kindOfMark(node);
    if (!diffPillWords(node, state.proposal)) return '';
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
  return { dataSummary, threadsSection, diffSection, nameOf, nodeById };
}

/** Mounts the node panel; see the top of this file */
export function mount(root, inst, options = {}) {
  const { state } = inst;
  const scope = scopeOf(inst);
  const sections = sectionsOf(inst);
  const inline = options.inline === true;
  const made = [
    ...place(inst, root, markup().drawer, options.slots, 'drawer'),
    ...(inline ? place(inst, root, `<p class="hx-panel-empty" data-corn="empty">${escHtml(t(inst, 'nodePanelEmpty'))}</p>`, null, 'empty') : place(inst, root, markup().backdrop, options.slots, 'backdrop')),
  ];
  /** An element of this piece by id (the piece's own, whatever else the root holds) */
  const own = (id) => {
    for (const el of made) {
      if (el.id === id) return el;
      const found = el.querySelector(`[id="${id}"]`);
      if (found) return found;
    }
    return null;
  };
  scope.keepParts(...made);
  const drawer = own('spec-drawer');
  const backdrop = inline ? { hidden: true } : own('drawer-backdrop'); // (a box of its own has no dim layer)
  const empty = inline ? made.find((el) => el.matches('[data-corn="empty"]')) : null;
  const setEmpty = (shown) => { if (empty) empty.hidden = !shown; };
  let gone = false;

  const litNow = () => activeSubgraph(state.selectedNode, inst.viewEdges(), { throughChildren: state.throughChildren, kind: state.selectedKind });

  /** The panel's "Calls 12 · Reads 9" chips, the chosen kind's far ends, the switch, and the line that says how much is on screen, with Frame them */
  function linesHtml(node) {
    const sub = litNow();
    if (!sub || !sub.kinds.size) return '';
    const kinds = linesByKind(sub);
    const chips = kinds.map(({ kind, count, word }) => `<button type="button" class="hx-lines-kind" data-corn="lines-kind" data-corn-kind="quiet" data-lines-kind="${escHtml(kind)}" data-focus-key="kind:${escHtml(kind)}" aria-pressed="${sub.kind === kind}">${escHtml(word)} <span class="hx-lines-count" data-corn="count">${count}</span></button>`).join('');
    const open = sub.kind ? farEnds(sub, sub.kind).map((r) => `<button type="button" class="hx-linkbtn" data-corn="node-link" data-action="select-node" data-id="${escHtml(r.id)}"><span class="hx-sr-only">${r.out ? 'to ' : 'from '}</span><span aria-hidden="true">${r.out ? '→' : '←'}</span> ${escHtml(sections.nameOf(r.id))}</button>`) : [];
    const list = open.length ? `<div class="hx-lines-list">${capped(open, LINES_CAP)}</div>` : '';
    const hasChildren = activeSubgraph(node, inst.viewEdges(), { throughChildren: false }).childIds.size > 0;
    const through = hasChildren ? `<label class="hx-lines-switch"><input type="checkbox" data-corn="lines-switch" data-lines-switch data-focus-key="switch"${state.throughChildren ? ' checked' : ''}> <span>${escHtml(t(inst, 'throughChildren'))}</span></label>` : '';
    const { connected, off } = reach(inst);
    return `<div class="hx-sec-block hx-lines" id="drawer-lines" data-corn="lines-by-kind"><h3 class="hx-sec-title">Lines</h3><div class="hx-chips" role="group" aria-label="Lit lines by kind">${chips}</div>${list}${through}<div class="hx-lines-reach"><span data-lines-reach>${escHtml(connectedLine(connected, off))}</span> <button type="button" data-corn="frame-button" data-corn-kind="secondary" class="hx-btn hx-btn--secondary" data-action="frame-selection" data-focus-key="frame">${escHtml(t(inst, 'frame'))}</button></div></div>`;
  }

  /** Draws the lines block again after a switch or a kind was chosen; the focus stays on the control that was used */
  function paintLines() {
    const box = own('drawer-lines');
    if (!box || !state.selectedNode) return;
    const active = inst.active();
    const key = active && box.contains(active) ? active.dataset.focusKey : '';
    const holder = inst.doc.createElement('div');
    holder.innerHTML = linesHtml(state.selectedNode);
    addParts(holder);
    const next = holder.firstElementChild;
    if (next) box.replaceWith(next); else box.remove();
    if (key) { const again = own('drawer-lines'); const el = again && [...again.querySelectorAll('[data-focus-key]')].find((x) => x.dataset.focusKey === key); if (el) el.focus(); }
  }

  /** One step through the panel's lines controls: a kind's chip lights that kind alone (the same chip again lights them all), the switch widens the set */
  function onLinesClick(e) {
    const chip = e.target.closest && e.target.closest('[data-lines-kind]');
    if (!chip || !state.selectedNode) return false;
    const kind = chip.dataset.linesKind;
    state.selectedKind = state.selectedKind === kind ? null : kind;
    inst.touchScene();
    inst.map.render();
    paintLines();
    const sub = litNow();
    announce(inst, sub && sub.kind ? `Showing ${kindPanelWord(sub.kind).toLowerCase()} only: ${sub.edges.length} ${sub.edges.length === 1 ? 'line' : 'lines'}` : 'Showing every kind of line');
    return true;
  }
  function onLinesChange(e) {
    const box = e.target.closest && e.target.closest('[data-lines-switch]');
    if (!box || !state.selectedNode) return;
    state.throughChildren = !!box.checked;
    state.selectedKind = null; // the set changed under the chosen kind: it may not be in it
    inst.touchScene();
    inst.map.render();
    paintLines();
    const sub = litNow();
    announce(inst, `${state.throughChildren ? 'Including' : 'Not including'} its children's lines: ${sub ? sub.connectedNodeIds.size - 1 : 0} connected`);
  }

  const metaList = own('drawer-meta-list');
  scope.listen(metaList, 'click', (e) => { if (!onLinesClick(e)) toggleCapped(e.target); });
  scope.listen(metaList, 'change', onLinesChange);

  /** Keeps "9 connected · 3 off screen" true as the camera moves (after every draw, while a node is selected and its panel is open) */
  scope.own(inst.map.onPaint(() => {
    if (!state.selectedNode) return;
    const el = drawer.querySelector('[data-lines-reach]');
    if (!el) return;
    const { connected, off } = reach(inst);
    const text = connectedLine(connected, off);
    if (el.textContent !== text) el.textContent = text;
  }));

  /** Draws "Threads" again in the open panel (the list was just read, or the map changed); nothing else in the panel moves */
  function repaintThreads() {
    const box = own('drawer-threads');
    if (!box || !state.selectedNode) return;
    box.innerHTML = sections.threadsSection(state.selectedNode);
    addParts(box);
  }

  /** Fills the panel for a node and opens it. The selection itself is the instance's (engine/selection.js); this is what is shown for it. */
  function show(node, { frame = false } = {}) {
    if (!node || gone) return;
    const title = own('drawer-title');
    title.textContent = node.tag ? `<${node.tag}>` : node.label;
    title.classList.toggle('hx-mono', node.type === 'page' || !!node.tag); // a route or a tag reads as code
    own('drawer-badge').textContent = typeWords(node);
    const host = hostOf(node);
    own('drawer-host').textContent = host ? ` · ${host}` : '';
    const pill = diffPillWords(node, state.proposal);
    const pillEl = own('drawer-diff');
    pillEl.textContent = pill;
    pillEl.hidden = !pill;
    const pillState = markState(pill ? node.mark : ''); // added, changed, removed or edit
    if (pillState) pillEl.dataset.cornState = pillState; else delete pillEl.dataset.cornState;
    const lead = own('drawer-description');
    lead.textContent = node.desc || '';
    lead.hidden = !node.desc;

    const facts = `${node.file ? section('File', [code(node.file)]) : ''}${flowSummary(inst, node)}${sections.dataSummary(node)}`;
    const live = inst.ask('live:section', node) || '';
    metaList.innerHTML = `${linesHtml(node)}${facts ? `<div class="hx-facts">${facts}</div>` : ''}
    <div id="drawer-live">${live}</div>
    ${nodeMockupsHtml(state, node.id)}
    <div id="drawer-threads">${sections.threadsSection(node)}</div>
    ${sections.diffSection(node)}`;
    addParts(metaList);
    inst.emit('threads:ensure'); // the Work panel reads the threads once, for "Mentioned in"
    inst.emit('live:hydrate', own('drawer-live'));

    // The actions: Open file (the node's file on the forge) is the primary one; with an address too, Open route is the quiet one.
    // The proposal's head branch is not known here (the proposals list does not carry it): the file is at the default branch.
    const fileBtn = own('drawer-file-btn');
    const openBtn = own('drawer-open-btn');
    const file = node.file && state.forge ? fileUrl(state.forge, node.file, state.forge.baseBranch) : null;
    fileBtn.hidden = !file;
    if (file) fileBtn.href = file; else fileBtn.removeAttribute('href');
    const route = !!(node.url && /^https?:\/\//.test(node.url));
    if (route) openBtn.href = node.url; else openBtn.removeAttribute('href');
    openBtn.hidden = !route;
    openBtn.className = file ? 'hx-btn hx-btn--quiet hx-foot-btn' : 'hx-open';
    if (file) openBtn.dataset.cornKind = 'quiet'; else openBtn.dataset.cornKind = 'primary'; // the route is the primary action when there is no file
    openBtn.textContent = `${t(inst, 'openRoute')} ↗`;
    fileBtn.textContent = `${t(inst, 'openFile')} ↗`;
    own('drawer-run-btn').hidden = !(state.proposalSlug && inst.ask('forge:can-start'));

    drawer.classList.add('drawer-open');
    drawer.inert = false; // closed, it waits off screen: inert, so Tab never reaches its buttons (MAP-02)
    backdrop.hidden = false;
    setEmpty(false);
    if (!inline) showSheet(inst, 'drawer'); // on a phone it takes Work's place (the node sheet and Work take turns), and comes back from away when its node is tapped again
    if (!frame && !inline) keepSelectedInView(); // with `frame`, the selection flies the camera to the node once this returns (engine/selection.js)
    inst.emit('node:painted', { node });
  }

  /**
   * Fills the panel for an edge and opens it: what it is, and what the proposal says about it (the engine's `showEdge` selects it and says `node:show-edge`).
   * As ever, an edge alone gets no sheet on a phone (the panel is opened, not `showSheet`ed), and Escape on the map does not close it.
   */
  function showEdge(edge) {
    if (!edge || gone) return;
    const row = (label, value) => (value ? `<div class="hx-fact" data-corn="section"><div class="hx-fact-k">${escHtml(label)}</div><div class="hx-fact-v">${escHtml(value)}</div></div>` : '');
    const kind = edge.kind || (edge.dashed ? 'usage' : 'ownership');
    const facts = row('Kind', kind) + row('Flow', edge.flow) + row('Label', edge.label) + row('Reads', Array.isArray(edge.keys) ? edge.keys.join(', ') : '');
    const title = own('drawer-title');
    title.textContent = `${sections.nameOf(edge.from)} → ${sections.nameOf(edge.to)}`;
    title.classList.remove('hx-mono');
    own('drawer-badge').textContent = 'Edge';
    own('drawer-host').textContent = '';
    own('drawer-diff').hidden = true;
    const lead = own('drawer-description');
    lead.textContent = '';
    lead.hidden = true;
    metaList.innerHTML = `${facts ? `<div class="hx-facts">${facts}</div>` : ''}
    <div class="hx-facts">
      <div class="hx-fact" data-corn="section"><div class="hx-fact-k">From</div><div class="hx-fact-v"><button data-corn="node-link" type="button" class="hx-linkbtn" data-action="select-node" data-id="${escHtml(edge.from)}">${escHtml(sections.nameOf(edge.from))}</button></div></div>
      <div class="hx-fact" data-corn="section"><div class="hx-fact-k">To</div><div class="hx-fact-v"><button data-corn="node-link" type="button" class="hx-linkbtn" data-action="select-node" data-id="${escHtml(edge.to)}">${escHtml(sections.nameOf(edge.to))}</button></div></div>
    </div>${proposalPanelHtml(edge)}`;
    addParts(metaList);
    own('drawer-open-btn').hidden = true;
    own('drawer-file-btn').hidden = true;
    own('drawer-run-btn').hidden = true;
    drawer.classList.add('drawer-open');
    drawer.inert = false; // closed, the panel is inert (MAP-02): open for an edge, its links and its Close are reached as a node's are
    backdrop.hidden = false;
    setEmpty(false);
  }

  /**
   * On a phone the node's sheet covers the bottom of the map (engine/sheets.js): when the selected node is under it, or
   * gets covered as the sheet expands, pan the map (never zoom it) so the node is in the part still showing (F32)
   */
  function keepSelectedInView() {
    const node = state.selectedNode;
    if (!node || !state.width || !isPhone(inst) || gone) return;
    const covered = measureCovered(inst);
    const next = panIntoView(state.camera, node, { left: 0, top: 0, right: state.width, bottom: state.height - covered }, node.r * state.camera.zoom + 16);
    if (!next) return;
    Object.assign(state.camera, next);
    inst.map.render();
  }

  function close() {
    drawer.classList.remove('drawer-open');
    drawer.inert = true;
    backdrop.hidden = true;
    setEmpty(true);
    if (!inline) collapseSheet(inst, 'drawer'); // the next node opens as a peek on a phone
  }

  /** Start a run: the Start dialog of the Work panel, on the proposal that is open */
  function startRun() {
    if (state.proposalSlug) inst.emit('forge:start', { slug: state.proposalSlug, returnTo: '#drawer-run-btn' });
  }

  scope.own(() => clearTimeout(copyState(inst).timer));

  // The panel's own buttons
  const ACTIONS = {
    'close-drawer': () => clearSelection(inst, { source: 'tap' }),
    'copy-spec': () => copySpec(inst, own('copy-spec-result')),
    'start-run': () => startRun(),
    'select-node': (el) => selectNode(inst, sections.nodeById(el.dataset.id), { frame: true, source: 'link' }), // a link or a list row: the camera follows (spec 0008 D6)
    'frame-selection': () => frameThem(inst),
  };
  scope.listen(drawer, 'click', (e) => {
    const target = e.target.closest && e.target.closest('[data-action]');
    if (!target) return;
    const action = ACTIONS[target.dataset.action];
    if (action) action(target);
    // The panel's ✕: the focus would be left on a hidden button, so it goes back to the map
    if (target.dataset.action === 'close-drawer' && state.canvas) scope.timeout(() => state.canvas.focus(), 0);
  });
  // A thread listed in the panel opens in the Work panel, and "Start a thread about this" opens its New idea form (the Work panel hears both)
  scope.listen(drawer, 'click', (e) => {
    const open = e.target.closest && e.target.closest('[data-thread-open]');
    if (open) { inst.emit('thread:open', { number: Number(open.dataset.threadOpen) }); return; }
    const start = e.target.closest && e.target.closest('[data-thread-start]');
    if (start && state.selectedNode) inst.emit('thread:start', { node: state.selectedNode });
  });
  // The threads that mention nodes changed (the list was read, or the map changed): the section is drawn again
  scope.on('threads:changed', () => repaintThreads());
  // The dim layer behind the panel: on a phone a tap there folds the panel to its peek; elsewhere it closes it
  if (!inline) {
    scope.listen(backdrop, 'click', (e) => {
      if (isPhone(inst)) { onBackdrop(inst, e); return; }
      clearSelection(inst, { source: 'tap' });
    }, true);
  }
  // Escape anywhere in the panel closes it, and the map has the focus again
  scope.listen(drawer, 'keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (e.target.closest && e.target.closest('select, input, textarea')) return; // a field's own Escape first
    e.preventDefault();
    clearSelection(inst, { source: 'keyboard' });
    if (state.canvas) state.canvas.focus();
    announce(inst, 'Panel closed');
  });

  scope.on('panel:present', () => true); // the map says "Panel closed", not "Selection cleared"
  // A slide-over covers the right of the map by its width; a panel in a box of its own (`inline`) covers nothing
  scope.on('panel:covers', () => (!inline && !gone && !drawer.hidden && drawer.classList.contains('drawer-open') ? { right: drawer.offsetWidth } : undefined));
  scope.on('node:show', ({ node, frame }) => show(node, { frame }));
  scope.on('node:close', close);
  scope.on('node:show-edge', ({ edge }) => showEdge(edge));
  // Enter on the map goes into the open panel: its title takes the focus, so a screen reader starts there and Tab goes on into it
  scope.on('node:focus', () => {
    const title = own('drawer-title');
    if (!title) return;
    title.setAttribute('tabindex', '-1');
    title.focus();
  });
  if (!inline) {
    scope.own(onCoveredChange(inst, () => keepSelectedInView()));
    initSheets(inst);
    registerSheet(inst, 'drawer', drawer, { stub: () => ({ title: (own('drawer-title') && own('drawer-title').textContent) || 'Node' }) });
    scope.own(() => unregisterSheet(inst, 'drawer'));
  }

  // A node was selected before the panel came: it shows it
  if (state.selectedNode) show(state.selectedNode, { frame: false });

  scope.own(() => {
    gone = true;
    made.forEach((el) => el.remove());
  });

  return {
    elements: made,
    show,
    close,
    repaintThreads,
    copySpec: () => copySpec(inst, own('copy-spec-result')),
    startRun,
    keepSelectedInView,
    update(props) {
      if (props && 'node' in props) { if (props.node) selectNode(inst, props.node, { source: 'api' }); else clearSelection(inst, { source: 'api' }); return; }
      if (state.selectedNode && drawer.classList.contains('drawer-open')) show(state.selectedNode, { frame: false });
    },
    destroy: () => scope.destroy(),
  };
}
