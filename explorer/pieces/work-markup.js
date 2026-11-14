/**
 * @module explorer/pieces/work-markup
 *
 * The Work piece's markup (spec 0011 D3, spec 0012 D6): the Work list (the panel's lists, opened by the List toggle of the Work view), the layer of marks
 * over the map, and the two dialogs the actions open (the confirm step and Start an agent), which sit at the end of the page, over a scrim. A piece of
 * work's detail and actions are the node panel's (work-model.js `workPanelHtml` puts its place, `forge-detail`, in the panel). Every `data-corn` element also gets its `part` when
 * the piece places it (engine/piece.js).
 */

import { withParts } from '../engine/piece.js';

/** The markup, each hook with its part of the same name (engine/piece.js `place` would give it too) */
export const markup = () => Object.fromEntries(Object.entries(markupOf()).map(([slot, html]) => [slot, withParts(html)]));

const markupOf = () => ({
  /** The Work list: Specs, PRs, Issues, Threads, Runs and Deploys, in the order of the loop: a slide-over from the left on desktop, a bottom sheet on a phone; hidden and inert until the Work view opens it. A row selects its node; the detail is the node panel's. `forge-panel` on the inner box is the old name of the hook, kept for one release (docs/theming.md) */
  panel: `<aside id="forge-panel" class="hx-forge glass" aria-label="Work list" inert hidden data-corn="work-panel">
  <div class="hx-forge-body" data-corn="forge-panel">
    <div class="hx-forge-top" data-corn="work-top">
    <div class="hx-forge-head" data-corn="work-head">
      <h2 id="forge-title" class="hx-drawer-title" data-corn="work-title" tabindex="-1">Work list</h2>
      <button type="button" class="hx-btn hx-btn--quiet" data-action="refresh-forge" title="Ask the forge again" data-corn-kind="quiet">Refresh</button>
      <button type="button" class="hx-close" data-action="close-forge" aria-label="Close" data-corn-kind="icon">✕</button>
    </div>
    <div class="hx-forge-tabs" role="group" aria-label="Show" data-corn="tabs">
      <button type="button" class="hx-forge-tab" data-forge-kind="specs" aria-pressed="true" title="The proposals: what a change would add, change and remove" data-corn="tab"><span data-corn-string="tabSpecs">Specs</span><span class="hx-forge-count" data-corn="count"></span></button>
      <button type="button" class="hx-forge-tab" data-forge-kind="pulls" aria-pressed="false" title="Pull requests" data-corn="tab"><span data-corn-string="tabPulls">PRs</span><span class="hx-forge-count" data-corn="count"></span></button>
      <button type="button" class="hx-forge-tab" data-forge-kind="issues" aria-pressed="false" data-corn="tab"><span data-corn-string="tabIssues">Issues</span><span class="hx-forge-count" data-corn="count"></span></button>
      <button type="button" class="hx-forge-tab" data-forge-kind="threads" aria-pressed="false" title="Ideas and spec conversations, with the nodes they mention" data-corn="tab"><span data-corn-string="tabThreads">Threads</span><span class="hx-forge-count" data-corn="count"></span></button>
      <button type="button" class="hx-forge-tab" data-forge-kind="work" aria-pressed="false" title="Agent runs, and the work grouped by issue and proposal with agent-made work marked" data-corn="tab"><span data-corn-string="tabRuns">Runs</span><span class="hx-forge-count" data-corn="count"></span></button>
      <button type="button" class="hx-forge-tab" data-forge-kind="deploys" aria-pressed="false" data-corn="tab"><span data-corn-string="tabDeploys">Deploys</span><span class="hx-forge-count" data-corn="count" hidden></span></button>
    </div>
    </div>
    <div id="forge-bar" class="hx-forge-bar">
      <p id="forge-status" class="hx-forge-status hx-faint"></p>
      <button data-corn="filter-chip" type="button" id="forge-filter-chip" class="hx-forge-chip" data-action="toggle-filters" aria-expanded="false" aria-controls="forge-filter-box" hidden>Filter<span class="hx-forge-count" data-corn="count" hidden></span></button>
    </div>
    <div id="forge-specs-search" class="hx-forge-specsearch" data-corn="specs-search" hidden>
      <label class="hx-forge-field hx-forge-field--text" data-corn="field">Find a spec<input data-corn="control" type="search" id="specs-search" class="hx-forge-input" placeholder="Title, name, summary" autocomplete="off" /></label>
    </div>
    <div id="forge-filter-box" class="hx-forge-controls" data-corn="filters" hidden>
      <div id="forge-work-filters" class="hx-forge-work-filters" hidden>
        <label class="hx-forge-toggle" data-corn="check-field"><input data-corn="control" type="checkbox" id="forge-work-agents" /> Agent-made only</label>
        <label class="hx-forge-toggle" data-corn="check-field"><input data-corn="control" type="checkbox" id="forge-work-finished" /> Include merged and closed</label>
      </div>
      <div id="forge-filters" class="hx-forge-filters">
        <label class="hx-forge-field" data-corn="field">State<select data-corn="control" id="forge-state" class="hx-forge-select"></select></label>
        <label class="hx-forge-field" data-corn="field">Label<select data-corn="control" id="forge-label" class="hx-forge-select"></select></label>
        <label class="hx-forge-field" data-corn="field">Author<select data-corn="control" id="forge-author" class="hx-forge-select"></select></label>
        <label class="hx-forge-field hx-forge-field--text" data-corn="field">Search<input data-corn="control" type="search" id="forge-text" class="hx-forge-input" placeholder="Title, number, label" autocomplete="off" /></label>
      </div>
    </div>
    <p id="forge-notice" class="hx-forge-notice" hidden data-corn="notice"></p>
    <p id="forge-act-note" class="hx-forge-notice" hidden data-corn="notice"></p>
    <section id="forge-notes" class="hx-forge-notes" aria-label="Release notes" hidden>
      <button data-corn="back" type="button" class="hx-forge-back" data-action="close-notes"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg><span class="hx-forge-back-text">All pull requests</span></button>
      <h3 id="notes-title" class="hx-forge-notes-title" data-corn="detail-title" tabindex="-1">Release notes</h3>
      <label class="hx-forge-field" data-corn="field">Since tag<select data-corn="control" id="notes-since" class="hx-forge-select"></select></label>
      <label class="hx-forge-field" data-corn="field">Draft, in Markdown<textarea data-corn="control" id="notes-preview" class="hx-forge-preview" rows="14" readonly spellcheck="false"></textarea></label>
      <div class="hx-forge-actions">
        <button data-corn-kind="secondary" type="button" id="notes-copy" class="hx-btn" data-action="copy-notes">Copy</button>
        <button type="button" id="notes-post" class="hx-btn hx-btn--approve" data-action="post-notes" aria-expanded="false" aria-controls="notes-confirm" data-corn-kind="approve">Post as draft …</button>
      </div>
      <p id="notes-message" class="hx-forge-msg" hidden data-corn="message"></p>
      <div id="notes-confirm" class="hx-forge-confirm" data-corn="confirm-form" role="group" aria-labelledby="notes-confirm-title" hidden>
        <h3 id="notes-confirm-title" class="hx-forge-confirm-title">Post as a draft release</h3>
        <p id="notes-confirm-words"></p>
        <label class="hx-forge-field" data-corn="field">Tag for the draft<input data-corn="control" type="text" id="notes-tag" class="hx-forge-input" autocomplete="off" spellcheck="false" /></label>
        <div class="hx-forge-actions">
          <button type="button" id="notes-confirm-yes" class="hx-btn hx-btn--approve" data-action="confirm-notes" data-corn-kind="approve">Create the draft</button>
          <button type="button" class="hx-btn hx-btn--quiet" data-action="cancel-notes" data-corn-kind="quiet">Cancel</button>
        </div>
      </div>
    </section>
    <section id="forge-runs" class="hx-forge-runs" aria-labelledby="forge-runs-title" hidden>
      <h3 id="forge-runs-title" class="hx-forge-runs-title">Agent runs</h3>
      <p id="forge-runs-runner" class="hx-forge-meta" hidden></p>
      <p id="forge-runs-status" class="hx-forge-meta hx-faint"></p>
      <p id="forge-runs-note" class="hx-forge-notice" hidden data-corn="notice"></p>
      <p id="forge-runs-trigger" class="hx-forge-notice" hidden data-corn="notice"></p>
      <div id="forge-runs-totals" data-corn="run-totals" role="group" aria-label="Tokens and cost the runners reported" hidden></div>
      <ul id="forge-runs-hand" class="hx-forge-meta" aria-label="Requests written by hand that started nothing" hidden></ul>
      <ul id="forge-runs-list" class="hx-forge-list" aria-label="Runs"></ul>
    </section>
    <ul id="forge-list" class="hx-forge-list" aria-label="Results"></ul>
    <div id="forge-foot" class="hx-forge-foot" data-corn="work-foot">
      <button data-corn-kind="secondary" type="button" id="notes-open" class="hx-btn" data-action="open-notes" hidden>Release notes …</button>
      <section id="forge-idea" class="hx-forge-notes" aria-label="New idea" data-corn-string-aria-label="newIdea" hidden>
        <div class="hx-forge-actions">
          <button type="button" id="idea-open" class="hx-btn hx-btn--approve" data-action="idea-open" aria-expanded="false" aria-controls="idea-form" data-corn-kind="approve"><span data-corn-string="newIdea">New idea</span> …</button>
        </div>
        <p id="idea-message" class="hx-forge-msg" role="status" hidden data-corn="message"></p>
        <div id="idea-form" data-corn="confirm-form" class="hx-forge-confirm" role="group" aria-labelledby="idea-form-title" hidden>
          <h3 id="idea-form-title" class="hx-forge-confirm-title" data-corn-string="newIdea">New idea</h3>
          <p id="idea-words"></p>
          <label class="hx-forge-field" data-corn="field">Title<input data-corn="control" type="text" id="idea-title" class="hx-forge-input" maxlength="256" autocomplete="off" /></label>
          <label class="hx-forge-field" data-corn="field">What is the idea?<textarea data-corn="control" id="idea-body" class="hx-forge-preview hx-thread-compose" rows="6" maxlength="20000" spellcheck="true"></textarea></label>
          <div class="hx-forge-actions">
            <button type="button" id="idea-send" class="hx-btn hx-btn--approve" data-action="idea-send" data-corn-kind="approve">Open the idea</button>
            <button type="button" class="hx-btn hx-btn--quiet" data-action="idea-cancel" data-corn-kind="quiet">Cancel</button>
          </div>
        </div>
      </section>
    </div>
    <p id="forge-rate" class="hx-forge-rate hx-faint"></p>
  </div>
</aside>`,
  /** The nodes agent runs are changing, marked over the map: a picture; the Runs view says the same in words */
  overlay: `<div id="run-overlay" class="hx-run-overlay" aria-hidden="true" hidden data-corn="run-overlay"></div>`,
  /** The confirm step of landing a pull request, starting a spec and opening a build issue, and Start an agent: modal dialogs over a scrim; the focus stays in them while one is open */
  dialogs: `<div id="forge-confirm" class="hx-confirm-scrim" hidden data-corn="dialog-scrim">
  <div class="hx-confirm glass" role="dialog" aria-modal="true" aria-labelledby="forge-confirm-title" aria-describedby="forge-confirm-body" data-corn="confirm-dialog">
    <h2 id="forge-confirm-title" class="hx-confirm-title" data-corn="dialog-title"></h2>
    <div id="forge-confirm-body"></div>
    <div class="hx-confirm-actions">
      <button data-corn-kind="secondary" type="button" class="hx-btn" data-action="forge-confirm-cancel">Cancel</button>
      <button type="button" class="hx-btn hx-btn--approve" data-action="forge-confirm-go" data-corn-kind="approve" data-corn-string="landIt">Land it</button>
    </div>
  </div>
</div>

<div id="agent-start" class="hx-confirm-scrim" hidden data-corn="dialog-scrim">
  <div class="hx-confirm glass" role="dialog" aria-modal="true" aria-labelledby="agent-start-title" aria-describedby="agent-start-words" data-corn="agent-dialog">
    <h2 id="agent-start-title" class="hx-confirm-title" data-corn="dialog-title" data-corn-string="startAgent">Start an agent</h2>
    <p id="agent-start-about" class="hx-forge-meta"></p>
    <p id="agent-start-runner" class="hx-forge-meta" hidden></p>
    <p id="agent-retry-note" class="hx-forge-meta" hidden></p>
    <form id="agent-start-form" class="hx-forge-confirm" data-corn="confirm-form" novalidate>
    <label class="hx-forge-field" data-corn="field">Kind of run<select data-corn="control" id="agent-kind" class="hx-forge-select"></select></label>
    <label id="agent-profile-field" class="hx-forge-field" hidden data-corn="field">Profile<select data-corn="control" id="agent-profile" class="hx-forge-select"></select></label>
    <fieldset id="agent-limits-edit" class="hx-forge-field hx-forge-limits" data-corn="field"><legend>Limits, hints for the runner (one left blank takes the config's, if any)</legend>
      <label class="hx-forge-field" data-corn="field">Minutes<input data-corn="control" type="number" id="agent-limit-minutes" class="hx-forge-input" min="0" step="any" inputmode="decimal" /></label>
      <label class="hx-forge-field" data-corn="field">Turns<input data-corn="control" type="number" id="agent-limit-turns" class="hx-forge-input" min="0" step="1" inputmode="numeric" /></label>
      <label class="hx-forge-field" data-corn="field">Cost<input data-corn="control" type="number" id="agent-limit-cost" class="hx-forge-input" min="0" step="any" inputmode="decimal" /></label>
      <label class="hx-forge-field" data-corn="field">Tokens<input data-corn="control" type="number" id="agent-limit-tokens" class="hx-forge-input" min="0" step="1" inputmode="numeric" /></label>
    </fieldset>
    <label class="hx-forge-field" data-corn="field">Brief for the runner<textarea data-corn="control" id="agent-brief" class="hx-forge-preview" rows="6" maxlength="20000" spellcheck="true"></textarea></label>
    <label id="agent-force-field" class="hx-forge-toggle" data-corn="check-field" hidden><input data-corn="control" type="checkbox" id="agent-force" /> Ask for another run on purpose</label>
    <p id="agent-start-words" class="hx-confirm-note"></p>
    <p id="agent-start-msg" class="hx-forge-msg hx-forge-msg--bad" role="alert" hidden data-corn="message" data-corn-state="failure"></p>
    <div class="hx-confirm-actions">
      <button data-corn-kind="secondary" type="button" class="hx-btn" data-action="agent-start-cancel">Cancel</button>
      <button type="submit" class="hx-btn hx-btn--approve" id="agent-start-go" data-corn-kind="approve" data-corn-string="askRunner">Ask the runner</button>
    </div>
    </form>
  </div>
</div>`,
});

