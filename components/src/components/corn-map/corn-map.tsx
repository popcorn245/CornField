import { Component, Element, Event, EventEmitter, Method, Prop, Watch } from '@stencil/core';
import { mount } from '../../../../explorer/pieces/map.js';
import { joinScope } from '../../../../explorer/pieces/scope-link.js';
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

/** What `cornAuth` says: the server wants the maintainer signed in, and where its sign-in is (it returns to this page) */
export interface CornAuthDetail {
  /** 401 or 403 */
  status: number;
  /** `<src>/auth/start?returnTo=<this page's address>`: a link the host or the piece puts in front of the person; the component never navigates the window */
  signIn: string;
}

/** What `cornError` says: something the pieces could not do, by `kind` */
export interface CornErrorDetail {
  /** `not-listed` (the server gave this page no CORS answer: its origin is not in `embed.origins`), `offline`, `server` (it answered with something that is not a config or a map), `address` (`src` is not an http(s) address), `version` (the package and the server differ by a minor or more; it keeps working), `theme` (the server's theme could not be had), `second-map` (a scope holds one map) */
  kind: 'not-listed' | 'offline' | 'server' | 'address' | 'version' | 'theme' | 'second-map';
  /** A few words more, plain text: the origin to list, the problem with the address, the two versions */
  message?: string;
}

/**
 * cornfield's map, in a shadow root. A thin shell (spec 0011 D1): it declares properties and events, mounts the engine's map piece in its
 * shadow root, passes each property change in, turns the piece's callbacks into events, and ends the piece when it leaves the page. It holds no
 * behaviour (test/shell.test.ts fails if this file imports anything but the Stencil runtime, the engine's pieces and CSS, or grows past a shell).
 */
@Component({
  tag: 'corn-map',
  styleUrls: ['../../../../explorer/pieces/map-stage.css', '../../../../explorer/pieces/status.css', 'corn-map.css'],
  encapsulation: { type: 'shadow' },
})
export class CornMap {
  @Element() el!: HTMLElement;

  /** The map to draw: the object topology.json holds (`{ nodes, edges }`). The object is not changed; the map works on copies. */
  @Prop() topology?: { nodes: Array<{ id: string; [key: string]: unknown }>; edges?: Array<{ from: string; to: string; [key: string]: unknown }> } | null;

  /** The id of the selected node. Set it to select; it follows the map's selection (a click, a key) and is reflected as an attribute. */
  @Prop({ reflect: true, mutable: true }) node?: string | null;

  /** `map` (the whole map) or `dataflow` (the data-flow preset: browser, servers, API, tables, services, outside systems) */
  @Prop() view: 'map' | 'dataflow' = 'map';

  /** The ground the map is drawn for: `light` or `dark` forces it for this element, `auto` (or none) follows the page's own `data-theme` or the system's setting */
  @Prop({ reflect: true }) theme?: 'light' | 'dark' | 'auto';

  /** `auto` (WebGL2 when there is one) or `canvas2d` */
  @Prop() renderer: 'auto' | 'canvas2d' = 'auto';

  /** The base address of a cornfield server, for a map with no `corn-scope` around it: it reads the config and the topology from there, with the signed-in maintainer's session. Inside a scope the scope's is used and this is ignored. */
  @Prop() src?: string;

  /** With `src` and no scope: wear the server's theme (its stylesheet and its `--corn-*` tokens). Inside a scope, the scope's `use-theme` decides. */
  @Prop() useTheme: boolean = false;

  /** The selection changed, whoever changed it: a click, a key, `node` or `focusNode()`. Once per change. */
  @Event() cornSelect!: EventEmitter<CornSelectDetail>;

  /** The first frame with a map in it is drawn (once per time the element is connected) */
  @Event() cornReady!: EventEmitter<void>;

  /** With `src` and no scope: the server answered a gated read with 401 or 403 and the maintainer has to sign in. The map shows a link to `signIn`. */
  @Event() cornAuth!: EventEmitter<CornAuthDetail>;

  /** With `src` and no scope: something the map could not do (see `kind`). In a scope, the scope says it. */
  @Event() cornError!: EventEmitter<CornErrorDetail>;

  private piece: ReturnType<typeof mount> | null = null;
  private scope: ReturnType<typeof joinScope> | null = null;
  private loaded = false;
  /** Property changes not yet passed in: after the render that reflects them (the tokens a `theme` attribute selects are in force then) */
  private changes: Record<string, unknown> = {};

  connectedCallback() {
    if (this.loaded) this.mountPiece(); // reconnected: new canvases, the old ones went with the piece
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
    if (this.scope) this.scope.leave();
    this.scope = null;
  }

  /** The scope around this map, or its instance, changed (a new server, a scope added or removed): ask again */
  private remount() {
    this.unmountPiece();
    if (this.loaded && this.el.isConnected) this.mountPiece();
  }

  private mountPiece() {
    if (this.piece || !this.el.shadowRoot) return;
    this.changes = {};
    this.scope = joinScope(this.el, () => this.remount());
    this.piece = mount(this.el.shadowRoot, this.scope.inst, {
      topology: this.topology, view: this.view, node: this.node, theme: this.theme, renderer: this.renderer, tokens: defaultTokens,
      src: this.src, useTheme: this.useTheme, version: __CORNFIELD_VERSION__, pageUrl: () => (typeof location === 'undefined' ? '' : location.href),
      onAuth: (detail: CornAuthDetail) => this.cornAuth.emit(detail),
      onError: (detail: CornErrorDetail) => this.cornError.emit(detail),
      onSelect: (detail: CornSelectDetail) => {
        this.node = detail.kind === 'node' ? detail.id : null;
        delete this.changes.node; // it came from the map: not passed back (an edge's selection is not a cleared node)
        this.cornSelect.emit(detail);
      },
      onReady: () => this.cornReady.emit(),
    });
  }

  componentDidRender() {
    const changes = this.changes;
    this.changes = {};
    if (this.piece && Object.keys(changes).length) this.piece.update(changes);
  }

  @Watch('topology')
  @Watch('view')
  @Watch('node')
  @Watch('theme')
  @Watch('renderer')
  changed(value: unknown, _old: unknown, name: string) {
    this.changes[name] = value;
  }

  /** A new server, or the server's theme turned on or off, is a new private scope: the map is mounted again (inside a scope these do nothing) */
  @Watch('src')
  @Watch('useTheme')
  addressChanged() {
    if (this.piece && this.scope && !this.scope.inst) this.remount();
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

  /** Reads the tokens again and draws: for a token changed at run time by something the map cannot see (a rule added to the page's head, a class on `<html>`) */
  @Method()
  async refresh(): Promise<void> {
    if (this.piece) this.piece.refresh();
  }
}
