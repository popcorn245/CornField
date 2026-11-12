import { Component, Element, Event, EventEmitter, Method, Prop, Watch } from '@stencil/core';
import { mount } from '../../../../explorer/pieces/map.js';
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

/**
 * cornfield's map, in a shadow root. A thin shell (spec 0011 D1): it declares properties and events, mounts the engine's map piece in its
 * shadow root, passes each property change in, turns the piece's callbacks into events, and ends the piece when it leaves the page. It holds no
 * behaviour (test/shell.test.ts fails if this file imports anything but the Stencil runtime, the engine's pieces and CSS, or grows past a shell).
 */
@Component({
  tag: 'corn-map',
  styleUrls: ['../../../../explorer/pieces/map-stage.css', 'corn-map.css'],
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

  /** The selection changed, whoever changed it: a click, a key, `node` or `focusNode()`. Once per change. */
  @Event() cornSelect!: EventEmitter<CornSelectDetail>;

  /** The first frame with a map in it is drawn (once per time the element is connected) */
  @Event() cornReady!: EventEmitter<void>;

  private piece: ReturnType<typeof mount> | null = null;
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
    if (this.piece) this.piece.destroy();
    this.piece = null;
  }

  private mountPiece() {
    if (this.piece || !this.el.shadowRoot) return;
    this.changes = {};
    this.piece = mount(this.el.shadowRoot, null, {
      topology: this.topology, view: this.view, node: this.node, theme: this.theme, renderer: this.renderer, tokens: defaultTokens,
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
