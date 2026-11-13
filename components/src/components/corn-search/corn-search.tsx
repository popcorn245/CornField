import { Component, Element, Event, EventEmitter, Method, Prop, Watch } from '@stencil/core';
import { mountAround } from '../../../../explorer/pieces/around.js';
import { joinScope } from '../../../../explorer/pieces/scope-link.js';
import * as piece from '../../../../explorer/pieces/search.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/** What `cornSearch` says: the search's query, or its chosen match, changed */
export interface CornSearchDetail {
  /** What is searched for now (trimmed), or an empty string once it is cleared */
  query: string;
  /** The id of the match chosen with Enter, a row or the arrow buttons, or null while none is */
  current: string | null;
}

/**
 * Search: a field, the count of what it found, a list of the matches by kind, and stepping through them. Choosing a match selects it on the map in the same
 * `<corn-scope>` and flies the map to it. A thin shell (spec 0011 D1): it mounts the engine's piece (explorer/pieces/search.js) in its shadow root on the
 * instance of the nearest `<corn-scope>`, through explorer/pieces/around.js, and ends it when it leaves the page. It holds no behaviour (test/shell.test.ts).
 */
@Component({
  tag: 'corn-search',
  styleUrls: ['../../../../explorer/css/base.css', '../../../../explorer/css/search.css', 'corn-search.css'],
  encapsulation: { type: 'shadow' },
})
export class CornSearch {
  @Element() el!: HTMLElement;

  /** What is searched for. Set it to search; it follows what the person types. It is not reflected: a query changes with every key. */
  @Prop({ mutable: true }) query?: string;

  /** The query, or the chosen match, changed, whoever changed it: typing, `query`, Enter, a row. Once per change. */
  @Event() cornSearch!: EventEmitter<CornSearchDetail>;

  private piece: ReturnType<typeof mountAround> | null = null;
  private scope: ReturnType<typeof joinScope> | null = null;
  private loaded = false;
  /** Property changes not yet passed in: after the render that reflects them */
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
    if (this.scope) this.scope.leave();
    this.scope = null;
  }

  /** The scope around this element, or its instance, changed (a new server, a scope added or removed): ask again */
  private remount() {
    this.unmountPiece();
    if (this.loaded && this.el.isConnected) this.mountPiece();
  }

  private mountPiece() {
    if (this.piece || !this.el.shadowRoot) return;
    this.changes = {};
    this.scope = joinScope(this.el, () => this.remount());
    this.piece = mountAround(piece, this.el.shadowRoot, this.scope.inst, {
      tokens: defaultTokens,
      initial: this.query ? { query: this.query } : {},
      onSearch: (detail: CornSearchDetail) => {
        this.query = detail.query;
        delete this.changes.query; // it came from the field: not passed back
        this.cornSearch.emit(detail);
      },
    });
  }

  componentDidRender() {
    const changes = this.changes;
    this.changes = {};
    if (this.piece && Object.keys(changes).length) this.piece.update(changes);
  }

  @Watch('query')
  changed(value: unknown, _old: unknown, name: string) {
    this.changes[name] = value;
  }

  /** Puts the focus in the field, its text selected: for a shortcut of the host's own */
  @Method()
  async focusField(): Promise<void> {
    if (this.piece) this.piece.focusField();
  }
}
