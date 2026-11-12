import { Component, Element, Event, EventEmitter, Method, Prop, Watch } from '@stencil/core';
import { mount } from '../../../../explorer/pieces/map.js';
import { adoptDefaultTokens } from '../../../../explorer/pieces/adopt-tokens.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/**
 * cornfield's map, in a shadow root. A thin shell (spec 0011 D1): it declares properties and events, mounts the engine's map piece in its
 * shadow root, passes property changes in, and ends the piece when it leaves the page. It holds no behaviour (test/shell.test.ts fails if this
 * file imports anything but the Stencil runtime, the engine's pieces and CSS).
 */
@Component({
  tag: 'corn-map',
  styleUrls: ['../../../../explorer/pieces/map-stage.css', 'corn-map.css'],
  encapsulation: { type: 'shadow' },
})
export class CornMap {
  @Element() el!: HTMLElement;

  /** The map to draw: the object topology.json holds (`{ nodes, edges }`). The object is not changed; the map works on copies. */
  @Prop() topology?: { nodes: Array<Record<string, unknown> & { id: string }>; edges?: Array<Record<string, unknown>> } | null;

  /** The id of the selected node. Set it to select; it follows the map's selection (a click, a key) and is reflected as an attribute. */
  @Prop({ reflect: true, mutable: true }) node?: string | null;

  /** `map` (the whole map) or `dataflow` (the data-flow preset: browser, servers, API, tables, services, outside systems) */
  @Prop() view: 'map' | 'dataflow' = 'map';

  /** The ground the map is drawn for: `light` or `dark` forces it for this element, `auto` (or none) follows the page's own `data-theme` or the system's setting */
  @Prop({ reflect: true }) theme?: 'light' | 'dark' | 'auto';

  /** `auto` (WebGL2 when there is one) or `canvas2d` */
  @Prop() renderer: 'auto' | 'canvas2d' = 'auto';

  /** The selection changed, whoever changed it: a click, a key, `node` or `focusNode()`. `id` is null when it was cleared. */
  @Event() cornSelect!: EventEmitter<{ id: string | null; kind: 'node' | 'edge' }>;

  /** The first frame with a map in it is drawn (once per time the element is connected) */
  @Event() cornReady!: EventEmitter<void>;

  private piece: ReturnType<typeof mount> | null = null;
  private loaded = false;

  connectedCallback() {
    adoptDefaultTokens(this.el.getRootNode() as Document | ShadowRoot, defaultTokens);
    if (this.loaded) this.mountPiece(); // reconnected: new canvases, the old ones went with the piece
  }

  componentDidLoad() {
    this.loaded = true;
    this.mountPiece();
  }

  disconnectedCallback() {
    this.unmountPiece();
  }

  private mountPiece() {
    if (this.piece || !this.el.shadowRoot) return;
    this.piece = mount(this.el.shadowRoot, null, {
      topology: this.topology,
      view: this.view,
      node: this.node,
      theme: this.theme,
      renderer: this.renderer,
      onSelect: ({ id, kind }: { id: string | null; kind: 'node' | 'edge' }) => {
        if (kind === 'node' && (this.node ?? null) !== id) this.node = id;
        this.cornSelect.emit({ id, kind });
      },
      onReady: () => this.cornReady.emit(),
    });
  }

  private unmountPiece() {
    if (!this.piece) return;
    this.piece.destroy();
    this.piece = null;
  }

  // The attribute `theme` is reflected after a render, and the map reads the tokens the attribute selects: so the piece hears of every change once it is in place
  componentDidRender() {
    if (this.piece) this.piece.update({ topology: this.topology, view: this.view, node: this.node, theme: this.theme, renderer: this.renderer });
  }

  @Watch('topology')
  @Watch('view')
  @Watch('node')
  @Watch('theme')
  @Watch('renderer')
  changed() {
    // componentDidRender passes it in, after the host's attributes are in step
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
