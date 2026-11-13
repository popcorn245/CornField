import { Component, Element } from '@stencil/core';
import { mountAround } from '../../../../explorer/pieces/around.js';
import { joinScope } from '../../../../explorer/pieces/scope-link.js';
import * as piece from '../../../../explorer/pieces/node-panel.js';
import defaultTokens from '../../generated/default-tokens.css?inline';

/**
 * What is selected: the node the map has selected, its facts, flows, data, threads and (with a proposal) its diff, in a panel that fills the box its host gives it. It is for use inside a `<corn-scope>`, beside a `<corn-map>`.
 * A thin shell (spec 0011 D1): it mounts the engine's piece (explorer/pieces/node-panel.js) in its shadow root on the instance of the nearest `<corn-scope>`,
 * through explorer/pieces/around.js, and ends it when it leaves the page. It holds no behaviour (test/shell.test.ts). It has no properties of its own: the scope's selection is what it shows (set `node` on the map), and the map reports every change as `cornSelect`.
 */
@Component({
  tag: 'corn-node-panel',
  styleUrls: ['../../../../explorer/css/base.css', '../../../../explorer/css/node-panel.css', 'corn-node-panel.css'],
  encapsulation: { type: 'shadow' },
})
export class CornNodePanel {
  @Element() el!: HTMLElement;

  private piece: ReturnType<typeof mountAround> | null = null;
  private scope: ReturnType<typeof joinScope> | null = null;
  private loaded = false;

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
    this.scope = joinScope(this.el, () => this.remount());
    this.piece = mountAround(piece, this.el.shadowRoot, this.scope.inst, {
      tokens: defaultTokens,
      noMap: 'nodePanelEmpty', // with a scope but no map yet it says what it is for, not what it lacks
    });
  }
}
