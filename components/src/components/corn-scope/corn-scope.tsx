import { Component, Element, Event, EventEmitter, Prop, Watch } from '@stencil/core';
import { mountScope } from '../../../../explorer/pieces/scope.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/** What `cornAuth` says: the server wants the maintainer signed in, and where its sign-in is (it returns to this page) */
export interface CornScopeAuthDetail {
  /** 401 or 403 */
  status: number;
  /** `<src>/auth/start?returnTo=<this page's address>`: a link the host or the piece puts in front of the person; the component never navigates the window */
  signIn: string;
  /** What was refused: `load` (the config or the map), `proposal` (opening it), `facts` (the line above Approve), `review` (reading the last decision), `send` (the press itself) or `landing` (Undo of the hold) */
  during: 'load' | 'proposal' | 'facts' | 'review' | 'send' | 'landing';
}

/** What `cornError` says: something the pieces could not do, by `kind` */
export interface CornScopeErrorDetail {
  /** `not-listed` (the server gave this page no CORS answer: its origin is not in `embed.origins`), `offline`, `server` (it answered with something that is not a config or a map), `address` (`src` is not an http(s) address), `version` (the package and the server differ by a minor or more; it keeps working), `theme` (the server's theme could not be had), `second-map` (a scope holds one map), `second-section` (a scope holds one `corn-proposal`, one `corn-changes` and one `corn-decision`) or `proposal` (the proposal did not open: no such proposal, or the server refused) */
  kind: 'not-listed' | 'offline' | 'server' | 'address' | 'version' | 'theme' | 'second-map' | 'second-section' | 'proposal';
  /** A few words more, plain text: the origin to list, the problem with the address, the two versions, what the proposal's bar says */
  message?: string;
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

/**
 * Where the data comes from, and what the pieces inside it share (spec 0011 D5). It shows nothing of its own and has no shadow root: the `corn-*`
 * pieces inside it (today `corn-map`) share one instance (one selection, one camera, one topology), and `src` is the address of a cornfield server it
 * reads their config and topology from, with the signed-in maintainer's session. A thin shell (spec 0011 D1): the work is explorer/pieces/scope.js.
 */
@Component({
  tag: 'corn-scope',
})
export class CornScope {
  @Element() el!: HTMLElement;

  /** The base address of a cornfield server, `https://map.example.com` (an http(s) origin with an optional path). Another value is refused, and said in the pieces and in `cornError`. */
  @Prop() src?: string;

  /** The ground the pieces are drawn for: `light` or `dark` forces it, `auto` (or none) follows the page's own `data-theme` or the system's setting */
  @Prop({ reflect: true }) theme?: 'light' | 'dark' | 'auto';

  /** Wear the server's theme: its stylesheet goes into every piece, and its `--corn-*` tokens onto this element. Off by default: a host app has its own look. */
  @Prop() useTheme: boolean = false;

  /** The map to draw, for a host that fetches for itself: the object `topology.json` holds. With it (and `config`) no request is made. */
  @Prop() topology?: { nodes: Array<{ id: string; [key: string]: unknown }>; edges?: Array<{ from: string; to: string; [key: string]: unknown }> } | null;

  /** The object `/cornfield/config.json` holds, for a host that fetches for itself */
  @Prop() config?: { [key: string]: unknown } | null;

  /** The words the host overrides (a flat map of `strings` keys to text); they win over the server's */
  @Prop() strings?: { [key: string]: string } | null;

  /** The proposal the scope holds for every piece in it: its name (`0042-retire-the-old-export`), which the scope reads from the server, or, as a property only, the proposal object itself (shown for reading: a decision needs the name). The map narrows to it; `<corn-proposal>`, `<corn-changes>` and `<corn-decision>` show and decide it. It follows the reviewer: null once they close it in the bar, the name of a copy they open from it. Not reflected. */
  @Prop({ mutable: true }) proposal?: string | { [key: string]: unknown } | null;

  /** Which copy of the proposal: `checkout`, `pull/31` (a spec PR) or a worktree's name; with none the server answers with the first it lists */
  @Prop() source?: string | null;

  /** `before`, `diff` or `after`. Set it to choose; it follows the reviewer's own choice (the buttons on `<corn-proposal>`) and is reflected as an attribute. */
  @Prop({ reflect: true, mutable: true }) view?: 'before' | 'diff' | 'after' | null;

  /** The scope has its data: read from the server, or handed in. Once per server. */
  @Event() cornReady!: EventEmitter<void>;

  /** The server refused a read or a press with 401 or 403: the maintainer has to sign in. The piece shows a link to `signIn`. */
  @Event() cornAuth!: EventEmitter<CornScopeAuthDetail>;

  /** Something the pieces could not do */
  @Event() cornError!: EventEmitter<CornScopeErrorDetail>;

  /** The open proposal, or its view, changed: what cornfield's own page would put in its address bar. The host decides what to do with it. Sent by the scope, once, whoever changed it: a property, a button on `<corn-proposal>`, a way on from a bad link. */
  @Event() cornNavigate!: EventEmitter<CornNavigateDetail>;

  /** The server took a decision, Approve or Send back. Once per decision, after the server answered, whichever `<corn-decision>` was pressed. */
  @Event() cornDecision!: EventEmitter<CornDecisionDetail>;

  private scope: ReturnType<typeof mountScope> | null = null;
  private loaded = false;

  connectedCallback() {
    if (this.loaded) this.mountScope(); // reconnected: a new instance, the pieces below are told
  }

  componentWillLoad() {
    this.loaded = true;
    this.mountScope();
  }

  disconnectedCallback() {
    if (this.scope) this.scope.destroy();
    this.scope = null;
  }

  private mountScope() {
    if (this.scope) return;
    this.scope = mountScope(this.el, {
      src: this.src, theme: this.theme, useTheme: this.useTheme, topology: this.topology, config: this.config, strings: this.strings,
      proposal: this.proposal, source: this.source, view: this.view,
      tokens: defaultTokens, version: __CORNFIELD_VERSION__, pageUrl: () => (typeof location === 'undefined' ? '' : location.href),
      onReady: () => this.cornReady.emit(),
      onAuth: (detail: Omit<CornScopeAuthDetail, 'during'> & { during?: CornScopeAuthDetail['during'] }) => this.cornAuth.emit({ ...detail, during: detail.during || 'load' }),
      onError: (detail: CornScopeErrorDetail) => this.cornError.emit(detail),
      onNavigate: (detail: CornNavigateDetail) => {
        // the reviewer's own choice: the properties follow it (and Watch hands the same value back, which changes nothing)
        if (detail.view) this.view = detail.view;
        if (detail.change === 'closed') this.proposal = null;
        if (detail.change === 'opened' && detail.proposal) this.proposal = detail.proposal;
        this.cornNavigate.emit(detail);
      },
      onDecision: (detail: CornDecisionDetail) => this.cornDecision.emit(detail),
    });
  }

  @Watch('src')
  @Watch('theme')
  @Watch('useTheme')
  @Watch('topology')
  @Watch('config')
  @Watch('strings')
  @Watch('proposal')
  @Watch('source')
  @Watch('view')
  changed(value: unknown, _old: unknown, name: string) {
    if (this.scope) this.scope.update({ [name]: value });
  }
}
