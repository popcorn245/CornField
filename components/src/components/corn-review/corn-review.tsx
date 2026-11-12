import { Component, Element, Event, EventEmitter, Method, Prop, Watch } from '@stencil/core';
import { mount } from '../../../../explorer/pieces/review.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/** What `cornSelect` says: the node or the edge now selected, or none; and who chose it */
export interface CornSelectDetail {
  /** The node's id, `from->to` for an edge, or null when the selection was cleared */
  id: string | null;
  /** `node`, `edge`, or null when the selection was cleared */
  kind: 'node' | 'edge' | null;
  /** Who changed it: `tap`, `keyboard`, `api` (the `node` property or `focusNode()`), or `state` (a new topology without the node) */
  source: string;
  /** An edge's ends */
  from?: string;
  to?: string;
}

/** What `cornNavigate` says: what cornfield's own page would have put in its address bar for the proposal that is open now. The component never touches the host's address. */
export interface CornNavigateDetail {
  /** The proposal's name, or null once it is closed (or for a proposal handed in as an object with no name) */
  proposal: string | null;
  /** The copy of it that was asked for by name (`checkout`, `pull/31`, a worktree), only when it was; null otherwise, as cornfield's page leaves it out of the address */
  source: string | null;
  /** `before`, `diff` or `after`, or null once the proposal is closed */
  view: 'before' | 'diff' | 'after' | null;
  /** `opened` (a proposal opened), `view` (Before, Diff or After changed) or `closed` */
  change: 'opened' | 'view' | 'closed';
}

/** What the server answered to a decision: the review as it posted it */
export interface CornReviewRecord {
  /** `approved` or `notes` (a send back) */
  verdict: 'approved' | 'notes';
  /** When the server took it, an ISO time */
  at: string;
  /** Who it is recorded as: the signed-in maintainer */
  by?: string;
  /** false when the same approval stood already and the server posted nothing new */
  posted?: boolean;
  /** Anything else the server says about it */
  [key: string]: unknown;
}

/** What `cornDecision` says: the server took Approve or Send back. Every field is the decision's own, read when it was made, never from what is open now. */
export interface CornDecisionDetail {
  /** `approved`, or `notes` for a send back */
  outcome: 'approved' | 'notes';
  /** The proposal the decision was for, by name (the one that was open when the button was pressed), or null for a proposal that has no name */
  proposal: string | null;
  /** The copy of it the decision was for (`pull/31`), or null */
  source: string | null;
  /** Whether that proposal is still the one shown: false when another was opened, or this one closed, while the decision was sent */
  open: boolean;
  /** What the server answered */
  review: CornReviewRecord;
}

/** What `cornAuth` says: the server wants the maintainer signed in, and where its sign-in is (it returns to this page) */
export interface CornReviewAuthDetail {
  /** 401 or 403 */
  status: number;
  /** `<src>/auth/start?returnTo=<this page's address>`: a link the host or the piece puts in front of the person; the component never navigates the window */
  signIn: string;
  /** What was refused: `load` (the map), `proposal` (opening it), `facts` (the line above Approve), `review` (reading the last decision), `send` (the press itself) or `landing` (Undo of the hold) */
  during: 'load' | 'proposal' | 'facts' | 'review' | 'send' | 'landing';
}

/** What `cornError` says: something the review could not do, by `kind` */
export interface CornReviewErrorDetail {
  /** `not-listed` (the server gave this page no CORS answer: its origin is not in `embed.origins`), `offline`, `server` (it answered with something that is not a config or a map), `address` (`src` is not an http(s) address), `version` (the package and the server differ by a minor or more; it keeps working), `theme` (the server's theme could not be had) or `proposal` (the proposal did not open: no such proposal, or the server refused) */
  kind: 'not-listed' | 'offline' | 'server' | 'address' | 'version' | 'theme' | 'proposal';
  /** A few words more, plain text: the origin to list, the problem with the address, the two versions, what the proposal's bar says */
  message?: string;
}

/**
 * The one-tag review (spec 0011 D4, D5, D6): a proposal on the map, what it changes, its scenarios, and Approve and Send back, in a shadow root. A thin shell
 * (spec 0011 D1): it declares properties and events, mounts the engine's review piece (explorer/pieces/review.js) in its shadow root, passes each property
 * change in, turns the piece's callbacks into events, and ends the piece when it leaves the page. It holds no behaviour (test/shell.test.ts fails if this file
 * imports anything but the Stencil runtime, the engine's pieces and CSS, or grows past a shell). `src` is the address of a cornfield server it reads the
 * map and the proposal from, and decides on, as the signed-in maintainer. It needs a height from its host.
 */
@Component({
  tag: 'corn-review',
  styleUrls: [
    'corn-review.css',
    '../../../../explorer/css/base.css',
    '../../../../explorer/css/map.css',
    '../../../../explorer/css/node-panel.css',
    '../../../../explorer/css/proposal.css',
    '../../../../explorer/css/changes.css',
    '../../../../explorer/css/decision.css',
    '../../../../explorer/css/sheets.css',
    '../../../../explorer/css/review.css',
    '../../../../explorer/pieces/status.css',
  ],
  encapsulation: { type: 'shadow' },
})
export class CornReview {
  @Element() el!: HTMLElement;

  /** The base address of a cornfield server, `https://map.example.com` (an http(s) origin with an optional path): the review reads the config and the map from there, opens the proposal, and sends its decision, with the signed-in maintainer's session. Another value is refused, and said in the box and in `cornError`. Read when the element connects: a new `src` makes a new review. */
  @Prop() src?: string;

  /** The proposal to review: its name (`0042-retire-the-old-export`), which the review reads from the server, or, as a property only, the proposal object itself (shown for reading: a decision needs the name). It follows the reviewer: null once they close it in the bar, the name of a copy they open from it. Not reflected. */
  @Prop({ mutable: true }) proposal?: string | { [key: string]: unknown } | null;

  /** Which copy of the proposal: `checkout`, `pull/31` (a spec PR) or a worktree's name; with none the server answers with the first it lists */
  @Prop() source?: string | null;

  /** `before`, `diff` or `after`. Set it to choose; it follows the reviewer's own choice (the buttons on the bar) and is reflected as an attribute. */
  @Prop({ reflect: true, mutable: true }) view?: 'before' | 'diff' | 'after' | null;

  /** The id of the selected node. Set it to select; it follows the map's selection (a click, a key) and is reflected as an attribute. */
  @Prop({ reflect: true, mutable: true }) node?: string | null;

  /** The ground the review is drawn for: `light` or `dark` forces it for this element, `auto` (or none) follows the page's own `data-theme` or the system's setting */
  @Prop({ reflect: true }) theme?: 'light' | 'dark' | 'auto';

  /** With `src`: wear the server's theme (its stylesheet in this shadow root and its `--corn-*` tokens on this element). Off by default: a host app has its own look. */
  @Prop() useTheme: boolean = false;

  /** The map to draw, for a host that fetches for itself: the object `topology.json` holds. With it and `config` the review reads no map from the server. */
  @Prop() topology?: { nodes: Array<{ id: string; [key: string]: unknown }>; edges?: Array<{ from: string; to: string; [key: string]: unknown }> } | null;

  /** The object `/cornfield/config.json` holds, for a host that fetches for itself */
  @Prop() config?: { [key: string]: unknown } | null;

  /** The words the host overrides (a flat map of `strings` keys to text); they win over the server's */
  @Prop() strings?: { [key: string]: string } | null;

  /** The permission checker for the scenarios, a module the host imported itself: `{ check(items, { signal }) }`. A config never names one that is loaded (D10); with none, a checked step reads "Not checked". */
  @Prop() checker?: { check(items: unknown[], options?: { signal?: AbortSignal }): unknown; apps?: unknown; max?: number } | null;

  /** The first frame is drawn that shows the proposal asked for open, its title on the bar (or the bar saying why it is not): once per time the element is connected */
  @Event() cornReady!: EventEmitter<void>;

  /** The selection changed, whoever changed it: a click, a key, `node` or `focusNode()`. Once per change. */
  @Event() cornSelect!: EventEmitter<CornSelectDetail>;

  /** The open proposal, or its view, changed: what cornfield's own page would put in its address bar. The host decides what to do with it. */
  @Event() cornNavigate!: EventEmitter<CornNavigateDetail>;

  /** The server took a decision, Approve or Send back. Once per decision, after the server answered. */
  @Event() cornDecision!: EventEmitter<CornDecisionDetail>;

  /** The server wants the maintainer signed in (the read, or the press, was refused with 401 or 403). The review shows a link to `signIn`. */
  @Event() cornAuth!: EventEmitter<CornReviewAuthDetail>;

  /** Something the review could not do (see `kind`) */
  @Event() cornError!: EventEmitter<CornReviewErrorDetail>;

  private piece: ReturnType<typeof mount> | null = null;
  private loaded = false;
  /** Property changes not yet passed in: after the render that reflects them (the tokens a `theme` attribute selects are in force then) */
  private changes: Record<string, unknown> = {};

  connectedCallback() {
    if (this.loaded) this.mountPiece(); // reconnected: a new piece, the old one went with the disconnect
  }

  componentDidLoad() {
    this.loaded = true;
    this.mountPiece();
  }

  disconnectedCallback() {
    this.unmountPiece();
  }

  private unmountPiece() {
    if (this.piece) this.piece.destroy();
    this.piece = null;
  }

  /** A new server is a new review: the piece is made again */
  private remount() {
    this.unmountPiece();
    if (this.loaded && this.el.isConnected) this.mountPiece();
  }

  private mountPiece() {
    if (this.piece || !this.el.shadowRoot) return;
    this.changes = {};
    this.piece = mount(this.el.shadowRoot, null, {
      src: this.src, useTheme: this.useTheme, version: __CORNFIELD_VERSION__, pageUrl: () => (typeof location === 'undefined' ? '' : location.href), tokens: defaultTokens,
      topology: this.topology, config: this.config, strings: this.strings, checker: this.checker,
      proposal: this.proposal, source: this.source, view: this.view, node: this.node, theme: this.theme,
      onSelect: (detail: CornSelectDetail) => {
        this.node = detail.kind === 'node' ? detail.id : null;
        delete this.changes.node; // it came from the map: not passed back (an edge's selection is not a cleared node)
        this.cornSelect.emit(detail);
      },
      onNavigate: (detail: CornNavigateDetail) => {
        if (detail.view) { this.view = detail.view; delete this.changes.view; } // the reviewer's own choice: the property follows it, and it is not passed back
        // the same for the proposal: closed in the bar, or another copy opened from it; an object handed in has no name and stays the object
        if (detail.change === 'closed') { this.proposal = null; delete this.changes.proposal; }
        if (detail.change === 'opened' && detail.proposal) { this.proposal = detail.proposal; delete this.changes.proposal; }
        this.cornNavigate.emit(detail);
      },
      onDecision: (detail: CornDecisionDetail) => this.cornDecision.emit(detail),
      onAuth: (detail: CornReviewAuthDetail) => this.cornAuth.emit(detail),
      onError: (detail: CornReviewErrorDetail) => this.cornError.emit(detail),
      onReady: () => this.cornReady.emit(),
    });
  }

  componentDidRender() {
    const changes = this.changes;
    this.changes = {};
    if (this.piece && Object.keys(changes).length) this.piece.update(changes);
  }

  @Watch('proposal')
  @Watch('source')
  @Watch('view')
  @Watch('node')
  @Watch('theme')
  @Watch('useTheme')
  @Watch('topology')
  @Watch('config')
  @Watch('strings')
  @Watch('checker')
  changed(value: unknown, _old: unknown, name: string) {
    this.changes[name] = value;
  }

  /** A new server is a new review: it is mounted again */
  @Watch('src')
  addressChanged() {
    if (this.piece) this.remount();
  }

  /** Puts the whole map in view */
  @Method()
  async fit(): Promise<void> {
    if (this.piece) this.piece.fit();
  }

  /** Selects the node with this id and brings it into view; nothing happens when the map has no such node */
  @Method()
  async focusNode(id: string): Promise<void> {
    if (this.piece) this.piece.focusNode(id);
  }

  /** Reads the tokens again and draws: for a token changed at run time by something the review cannot see (a rule added to the page's head, a class on `<html>`) */
  @Method()
  async refresh(): Promise<void> {
    if (this.piece) this.piece.refresh();
  }
}
